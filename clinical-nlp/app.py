from __future__ import annotations

import re
from functools import lru_cache
from typing import Literal

import spacy
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

MODEL_NAME = "en_ner_bc5cdr_md"
MODEL_CORPUS = "BioCreative V CDR (biomedical literature; not local prescription validation)"
MAX_CHARS = 20_000

app = FastAPI(title="Anuvaad Biomedical NLP", version="1.0.0")


class ExtractRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_CHARS)


@lru_cache(maxsize=1)
def get_nlp():
    try:
        return spacy.load(MODEL_NAME)
    except OSError as exc:
        raise RuntimeError(f"Biomedical NER model {MODEL_NAME} is not installed") from exc


def context_for(sentence: str, mention_start: int, mention_end: int) -> tuple[str, list[str]]:
    before = sentence[:mention_start].lower()
    after = sentence[mention_end:].lower()
    cues: list[str] = []
    status: Literal["NEGATED", "HISTORICAL", "POSSIBLE", "ASSERTED", "UNDETERMINED"] = "ASSERTED"
    patterns = [
        ("NEGATED", r"\b(?:no|denies|denied|without|negative for|absence of|ruled out|not taking)\b"),
        ("HISTORICAL", r"\b(?:history of|previously|prior|formerly|resolved|remote)\b"),
        ("POSSIBLE", r"\b(?:possible|possibly|suspected|suspect|rule out|r/o|question of|cannot exclude)\b"),
    ]
    for label, pattern in patterns:
        matches = list(re.finditer(pattern, before[-100:]))
        if matches:
            status = label  # type: ignore[assignment]
            cues.append(matches[-1].group(0))
            break
    if re.search(r"\b(?:ruled out|resolved|not present|no longer)\b", after[:80]):
        status = "NEGATED"
        match = re.search(r"\b(?:ruled out|resolved|not present|no longer)\b", after[:80])
        if match:
            cues.append(match.group(0))
    return status, cues


@app.get("/health")
def health():
    try:
        nlp = get_nlp()
        return {"status": "ready", "model": MODEL_NAME, "corpus": MODEL_CORPUS, "pipeline": nlp.pipe_names}
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/extract")
def extract(request: ExtractRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Text is empty")
    try:
        doc = get_nlp()(text)
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Biomedical NLP model is unavailable") from exc

    mentions = []
    for ent in doc.ents:
        if ent.label_ not in {"CHEMICAL", "DISEASE"}:
            continue
        sentence = ent.sent
        start_in_sentence = ent.start_char - sentence.start_char
        end_in_sentence = ent.end_char - sentence.start_char
        context_status, cues = context_for(sentence.text, start_in_sentence, end_in_sentence)
        mentions.append({
            "text": ent.text,
            "type": ent.label_,
            "start": ent.start_char,
            "end": ent.end_char,
            "sentence": sentence.text[:500],
            "context": context_status,
            "contextCues": cues,
            "normalized": False,
        })

    return {
        "status": "candidate_mentions",
        "model": MODEL_NAME,
        "trainingCorpus": MODEL_CORPUS,
        "mentionCount": len(mentions),
        "mentions": mentions[:500],
        "notice": "Biomedical NER proposes text spans only. It does not establish a diagnosis, active status, medicine ingredient, allergy, or safety conclusion. Confirm each span against the source record.",
    }
