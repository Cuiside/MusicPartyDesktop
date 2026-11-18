package org.thornex.musicparty.dto;

import java.util.List;

public record PlayableMusic(
        String id,
        String name,
        List<String> artists,
        long duration,
        String platform,
        String url, // The actual playable URL for the audio
        String coverUrl,
        String kind,
        String externalUrl,
        boolean trial,
        long playableDurationMs,
        long fullDurationMs,
        String urlType
) {
    public PlayableMusic(String id, String name, List<String> artists, long duration, String platform,
                         String url, String coverUrl, String kind, String externalUrl) {
        this(id, name, artists, duration, platform, url, coverUrl, kind, externalUrl, false, duration, duration, "FULL");
    }
}

