"""Pydantic schemas for Stage-2 analysis JSON -> PDF renderer."""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, field_validator


class TitleTextItem(BaseModel):
    title: str = Field(default="", max_length=120)
    text: str = Field(min_length=1, max_length=800)


class FormModel(BaseModel):
    company: str = Field(min_length=1, max_length=160)
    companyLegalName: str = Field(default="", max_length=200)
    industry: str = Field(default="digital", max_length=120)
    servicesNeeded: str = Field(default="", max_length=300)


class AnalysisModel(BaseModel):
    whoYouAre: str = Field(min_length=1, max_length=2000)
    opportunity: str = Field(default="", max_length=2000)
    strengths: list[TitleTextItem] = Field(default_factory=list, max_length=8)
    painPoints: list[TitleTextItem] = Field(min_length=1, max_length=8)
    solutionPitch: str = Field(min_length=1, max_length=2500)
    tactics: list[str] = Field(min_length=1, max_length=12)
    deliverables: list[str] = Field(default_factory=list, max_length=12)
    whyPoints: list[str] = Field(default_factory=list, max_length=10)
    industry: str | None = None
    subtitle: str = Field(default="", max_length=160)

    @field_validator("tactics", "deliverables", "whyPoints", mode="before")
    @classmethod
    def _coerce_str_list(cls, v: Any) -> list:
        if v is None:
            return []
        if isinstance(v, str):
            return [v]
        return list(v)

    @field_validator("strengths", "painPoints", mode="before")
    @classmethod
    def _coerce_items(cls, v: Any) -> list:
        if v is None:
            return []
        if isinstance(v, dict):
            return [v]
        return list(v)


def validate_proposal_payload(form: dict, analysis: dict) -> dict:
    f = FormModel.model_validate(form)
    a = AnalysisModel.model_validate(analysis)
    return {"form": f.model_dump(), "analysis": a.model_dump()}
