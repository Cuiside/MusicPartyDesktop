package org.thornex.musicparty.media;

import org.junit.jupiter.api.Test;
import org.thornex.musicparty.dto.Music;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class PlayableTrialCompatibilityTest {
    private final Music music = new Music("1", "Song", List.of("Artist"), 60000, "netease", null, null);

    @Test void preservesPlayableAndFullDurationsForTrial() {
        var result = MediaDeliveryService.playable(music, "https://example.test/audio", "trial:true:duration:15000:start:0:end:15");
        assertTrue(result.trial());
        assertEquals(15000, result.duration());
        assertEquals(15000, result.playableDurationMs());
        assertEquals(60000, result.fullDurationMs());
    }

    @Test void fullAndUnknownTrialAreDistinguished() {
        var full = MediaDeliveryService.playable(music, "url", "trial:false:duration:60000:start::end:");
        assertFalse(full.trial());
        assertEquals(60000, full.duration());
        var unknown = MediaDeliveryService.playable(music, "url", "trial:true:duration::start::end:");
        assertTrue(unknown.trial());
        assertEquals(0, unknown.playableDurationMs());
        assertEquals(60000, unknown.fullDurationMs());
    }
}
