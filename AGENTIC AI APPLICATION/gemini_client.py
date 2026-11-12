import json
import re
import time
import requests
import config


class GeminiError(RuntimeError):
    pass


class RateLimitedError(GeminiError):
    pass


def _parse_json_loose(text: str) -> dict:
    txt = (text or "").strip()
    if not txt:
        raise json.JSONDecodeError("Empty response from model", "", 0)
    # Strip markdown fences and leading prose before first {
    txt = re.sub(r"^```(?:json)?\s*", "", txt, flags=re.I)
    txt = re.sub(r"\s*```$", "", txt, flags=re.I)
    # If model wrapped JSON in prose, keep from first { to last }
    if not txt.lstrip().startswith("{"):
        i = txt.find("{")
        j = txt.rfind("}")
        if i >= 0 and j > i:
            txt = txt[i:j + 1]
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        pass
    # Repair common trailing-comma issues
    repaired = re.sub(r",\s*([}\]])", r"\1", txt)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        pass
    start = depth = None
    best = None
    for i, ch in enumerate(txt):
        if ch == "{":
            if depth == 0 or depth is None:
                start = i
                depth = 0
            depth += 1
        elif ch == "}":
            if depth:
                depth -= 1
                if depth == 0 and start is not None:
                    best = txt[start:i + 1]
    if best:
        try:
            return json.loads(best)
        except json.JSONDecodeError:
            try:
                return json.loads(re.sub(r",\s*([}\]])", r"\1", best))
            except json.JSONDecodeError:
                pass
    raise json.JSONDecodeError(
        f"Could not parse JSON-like response (first 200 chars): {txt[:200]!r}",
        text, 0,
    )


class GeminiClient:
    def __init__(self, api_key: str = None):
        self.api_key = api_key or config.GEMINI_API_KEY
        if not self.api_key:
            raise GeminiError("No GEMINI_API_KEY set in .env")

    def chat(self, messages, temperature=0.2, max_tokens=1500,
             json_mode=False, max_retries=3, timeout: float = 12,
             tools: list | None = None):
        system_parts, contents = [], []
        for m in messages:
            role, content = m.get("role", "user"), m.get("content", "")
            if role == "system":
                system_parts.append(content)
            else:
                gemini_role = "model" if role in ("assistant", "model") else "user"
                contents.append({"role": gemini_role, "parts": [{"text": content}]})

        payload = {"contents": contents}
        if system_parts:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        gen_cfg = {"temperature": temperature, "maxOutputTokens": max_tokens}
        if json_mode:
            gen_cfg["responseMimeType"] = "application/json"
        payload["generationConfig"] = gen_cfg
        if tools:
            payload["tools"] = tools

        url = f"{config.GEMINI_BASE_URL}/models/{config.GEMINI_MODEL}:generateContent"
        last_error = None
        for attempt in range(max_retries):
            try:
                resp = requests.post(url, params={"key": self.api_key},
                                     headers={"Content-Type": "application/json"},
                                     json=payload, timeout=timeout)
                if resp.status_code == 429:
                    detail = self._error_detail(resp)
                    last_error = f"429 rate limited ({detail})"
                    if attempt + 1 < max_retries:
                        time.sleep(2 ** attempt)
                        continue
                    raise RateLimitedError(f"Gemini rate limit reached. {detail}")
                if resp.status_code == 503:
                    last_error = f"503 Service Unavailable"
                    if attempt + 1 < max_retries:
                        time.sleep(3 ** attempt)
                        continue
                    raise GeminiError(f"Gemini API unavailable (503). Try again later.")

                if resp.status_code in (400, 401, 403, 404):
                    raise GeminiError(f"Gemini HTTP {resp.status_code}: {self._error_detail(resp)}")
                resp.raise_for_status()
                data = resp.json()
                candidates = data.get("candidates") or []
                if not candidates:
                    raise GeminiError(f"Gemini returned no candidates: {data.get('promptFeedback')}")
                parts = candidates[0].get("content", {}).get("parts", [])
                text = "".join(p.get("text", "") for p in parts if p.get("text")).strip()
                if not text:
                    raise GeminiError(f"Gemini returned empty response: {data}")
                return text
            except requests.RequestException as e:
                last_error = str(e)
                if attempt + 1 < max_retries:
                    time.sleep(1)
                    continue
                raise GeminiError(f"Gemini HTTP request failed: {last_error}") from e
        raise GeminiError(f"Gemini request failed after retries: {last_error}")

    def chat_json(self, prompt: str, temperature=0.0, system: str = "") -> dict:
        """Send a prompt, expect JSON back. Optional system instruction."""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        text = self.chat(messages, temperature=temperature, max_tokens=2000, json_mode=True)
        return _parse_json_loose(text)

    @staticmethod
    def _error_detail(resp) -> str:
        try:
            body = resp.json()
            err = body.get("error") or {}
            msg, status = err.get("message"), err.get("status")
            if msg and status:
                return f"{status}: {msg}"
            if msg:
                return msg
        except (ValueError, json.JSONDecodeError):
            pass
        return (resp.text or "")[:300]
