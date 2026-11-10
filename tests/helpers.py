"""Shared fixtures for tests of the collector and fact extraction."""
from datetime import datetime, timezone


def vacancy(**changes):
    """A complete, eligible vacancy record; pass fields to override."""
    result = {
        "source": "poslovi", "url": "https://www.poslovi.rs/job/1", "title": "Python developer",
        "company": "Example", "location": "Beograd", "description": "Remote opportunity",
        "salary_min": 1500, "salary_currency": "EUR", "remote": True, "russian": True,
        "serbian_required": False, "published_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": None,
    }
    result.update(changes)
    return result
