"""Voice catalog endpoint."""

from typing import List, Optional

from fastapi import APIRouter, Depends

from service.dependencies import get_capcut_client
from service.models import VoiceInfoOut

router = APIRouter(prefix="/api", tags=["voices"])


@router.get("/voices", response_model=List[VoiceInfoOut])
async def list_voices(lang: Optional[str] = None, client=Depends(get_capcut_client)):
    voices = client.list_voices(lang=lang)
    return [
        VoiceInfoOut(
            voice_type=v.voice_type,
            display_name=v.display_name,
            resource_id=v.resource_id,
            lang=v.lang,
            lan=v.lan,
        )
        for v in voices
    ]
