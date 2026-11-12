"""LLM clients — Groq (default) or Gemini free tier behind one interface.

Swap with LLM_BACKEND=groq|gemini in .env (one-line config change).
"""
from __future__ import annotations

import json
from typing import Any

import requests

import config


class LLMError(RuntimeError):
    pass


class BaseLLMClient:
    """OpenAI-compatible chat + tools surface."""

    def chat(
        self,
        messages: list[dict],
        tools: list[dict] | None = None,
        *,
        temperature: float = 0.2,
    ) -> dict:
        """Return {"content", "tool_calls", "raw", optional "gemini_parts"}."""
        raise NotImplementedError


class GroqClient(BaseLLMClient):
    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or config.GROQ_API_KEY
        self.model = model or config.GROQ_MODEL
        if not self.api_key:
            raise LLMError("GROQ_API_KEY missing in .env")
        try:
            from groq import Groq
        except ImportError as exc:
            raise LLMError("Install groq: pip install groq") from exc
        self._client = Groq(api_key=self.api_key)

    def chat(self, messages, tools=None, *, temperature=0.2) -> dict:
        # Strip Gemini-only fields before sending to Groq
        clean = []
        for m in messages:
            item = {k: v for k, v in m.items() if k != "gemini_parts"}
            clean.append(item)
        kwargs: dict[str, Any] = {
            "model": self.model,
            "messages": clean,
            "temperature": temperature,
        }
        if tools:
            kwargs["tools"] = tools
            kwargs["tool_choice"] = "auto"
        resp = self._client.chat.completions.create(**kwargs)
        msg = resp.choices[0].message
        tool_calls = None
        if getattr(msg, "tool_calls", None):
            tool_calls = []
            for tc in msg.tool_calls:
                tool_calls.append({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.function.name,
                        "arguments": tc.function.arguments or "{}",
                    },
                })
        return {
            "content": msg.content,
            "tool_calls": tool_calls,
            "raw": resp,
        }


class GeminiClient(BaseLLMClient):
    """Gemini free-tier client with function-calling + thought_signature passthrough."""

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or config.GEMINI_API_KEY
        self.model = model or config.GEMINI_MODEL
        if not self.api_key:
            raise LLMError("GEMINI_API_KEY missing in .env")

    def chat(self, messages, tools=None, *, temperature=0.2) -> dict:
        system_bits = []
        contents = []
        pending_tool_responses: list[dict] = []

        def flush_tool_responses():
            nonlocal pending_tool_responses
            if not pending_tool_responses:
                return
            contents.append({"role": "user", "parts": pending_tool_responses})
            pending_tool_responses = []

        for m in messages:
            role = m.get("role")
            if role == "system":
                system_bits.append(m.get("content") or "")
                continue
            if role == "tool":
                pending_tool_responses.append({
                    "functionResponse": {
                        "name": m.get("name") or "tool",
                        "response": _as_response_dict(m.get("content")),
                    }
                })
                continue
            flush_tool_responses()
            if role == "assistant":
                # Prefer original Gemini parts (includes thought_signature)
                if m.get("gemini_parts"):
                    contents.append({"role": "model", "parts": m["gemini_parts"]})
                    continue
                parts = []
                if m.get("content"):
                    parts.append({"text": m["content"]})
                for tc in m.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    parts.append({
                        "functionCall": {
                            "name": fn.get("name"),
                            "args": _safe_json(fn.get("arguments"), as_dict=True),
                        }
                    })
                if parts:
                    contents.append({"role": "model", "parts": parts})
                continue
            # user
            contents.append({
                "role": "user",
                "parts": [{"text": m.get("content") or ""}],
            })
        flush_tool_responses()

        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature},
        }
        if system_bits:
            body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_bits)}]}
        if tools:
            decls = []
            for t in tools:
                fn = t.get("function") or t
                params = fn.get("parameters") or {"type": "object", "properties": {}}
                # Gemini rejects some JSON-schema keys like default
                params = _sanitize_schema(params)
                decls.append({
                    "name": fn.get("name"),
                    "description": fn.get("description") or "",
                    "parameters": params,
                })
            body["tools"] = [{"functionDeclarations": decls}]

        url = (
            f"{config.GEMINI_BASE_URL}/models/{self.model}:generateContent"
            f"?key={self.api_key}"
        )
        resp = requests.post(url, json=body, timeout=120)
        if resp.status_code >= 400:
            raise LLMError(f"Gemini HTTP {resp.status_code}: {resp.text[:500]}")
        data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            raise LLMError(f"Gemini empty response: {json.dumps(data)[:400]}")
        model_content = candidates[0].get("content") or {}
        parts = model_content.get("parts") or []
        text_bits = []
        tool_calls = []
        for i, part in enumerate(parts):
            if "text" in part and part.get("text"):
                text_bits.append(part["text"])
            fc = part.get("functionCall")
            if fc:
                tool_calls.append({
                    "id": f"call_{i}_{fc.get('name')}",
                    "type": "function",
                    "function": {
                        "name": fc.get("name"),
                        "arguments": json.dumps(fc.get("args") or {}),
                    },
                })
        return {
            "content": "\n".join(text_bits).strip() or None,
            "tool_calls": tool_calls or None,
            "gemini_parts": parts,  # must be echoed back for thought_signature
            "raw": data,
        }


def _as_response_dict(value: Any) -> dict:
    parsed = _safe_json(value, as_dict=True)
    if isinstance(parsed, dict):
        return parsed
    return {"result": parsed}


def _safe_json(value: Any, as_dict: bool = False) -> Any:
    if value is None:
        return {}
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        try:
            return json.loads(value)
        except Exception:
            return {"result": value}
    return {"result": str(value)}


def _sanitize_schema(schema: dict) -> dict:
    """Drop JSON Schema fields Gemini function decls often reject."""
    if not isinstance(schema, dict):
        return {"type": "object", "properties": {}}
    out = {}
    for k, v in schema.items():
        if k in ("default", "$schema", "additionalProperties"):
            continue
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: _sanitize_schema(pv) if isinstance(pv, dict) else pv
                      for pk, pv in v.items()}
        elif k == "items" and isinstance(v, dict):
            out[k] = _sanitize_schema(v)
        else:
            out[k] = v
    return out


def get_llm() -> BaseLLMClient:
    """Factory — change LLM_BACKEND in .env to swap providers."""
    backend = (config.LLM_BACKEND or "groq").lower()
    if backend == "gemini":
        return GeminiClient()
    return GroqClient()
