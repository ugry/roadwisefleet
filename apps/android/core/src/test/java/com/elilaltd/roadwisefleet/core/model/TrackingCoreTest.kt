package com.elilaltd.roadwisefleet.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the pure tracking rules (board #106, AND1-A4). No device,
 * no Android framework — these pin the cadence, the phase gate, the sample
 * validation and the batch shape.
 */
class TrackingCoreTest {

    private fun trip(id: String, status: String, tracking: Boolean) = Trip(
        id = id,
        status = status,
        origin = "A",
        destination = "B",
        cargo = null,
        customer = null,
        truckPlate = null,
        rateEur = null,
        updatedAtEpochMs = 0L,
        tracking = tracking,
    )

    @Test
    fun `phase is active only while the flag is on and the trip is open`() {
        assertEquals(TrackingPhase.ACTIVE, TrackingCore.phaseFor(tracking = true, status = "EN_ROUTE"))
        assertEquals(TrackingPhase.NOT_STARTED, TrackingCore.phaseFor(tracking = false, status = "ASSIGNED"))
        // DELIVERED is not terminal (POD_UPLOADED follows) but is past the active
        // assignment, so it must read STOPPED whether or not the flag is stale.
        assertEquals(TrackingPhase.STOPPED, TrackingCore.phaseFor(tracking = true, status = "DELIVERED"))
        assertEquals(TrackingPhase.STOPPED, TrackingCore.phaseFor(tracking = false, status = "DELIVERED"))
        assertEquals(TrackingPhase.STOPPED, TrackingCore.phaseFor(tracking = false, status = "POD_UPLOADED"))
        assertEquals(TrackingPhase.STOPPED, TrackingCore.phaseFor(tracking = false, status = "SETTLED"))
    }

    @Test
    fun `activeTrip picks the one tracking trip and ignores the rest`() {
        val trips = listOf(
            trip("a", "ASSIGNED", tracking = false),
            trip("b", "EN_ROUTE", tracking = true),
            trip("c", "DELIVERED", tracking = false),
        )
        assertEquals("b", TrackingCore.activeTrip(trips)?.id)
        assertNull(TrackingCore.activeTrip(listOf(trip("a", "ASSIGNED", tracking = false))))
    }

    @Test
    fun `the 10-minute cadence is a minimum interval`() {
        val now = 1_000_000_000_000L
        assertTrue("never sampled is due", TrackingCore.isSampleDue(now, null))
        assertTrue("exactly one interval is due", TrackingCore.isSampleDue(now, now - TrackingCore.SAMPLE_INTERVAL_MS))
        assertFalse("a fresh sample is not", TrackingCore.isSampleDue(now, now - 60_000L))
    }

    @Test
    fun `normalizeSample accepts a good fix and copies the fields`() {
        val now = 1_000_000_000_000L
        val result = TrackingCore.normalizeSample(
            tripId = "t1",
            clientId = "c1",
            lat = 52.5,
            lng = 13.4,
            atEpochMs = now - 1_000,
            accuracyM = 12,
            nowEpochMs = now,
        )
        assertTrue(result is SampleResult.Ok)
        val sample = (result as SampleResult.Ok).sample
        assertEquals("t1", sample.tripId)
        assertEquals("c1", sample.clientId)
        assertEquals(12, sample.accuracyM)
    }

    @Test
    fun `normalizeSample is fail-fast on each bad field`() {
        val now = 1_000_000_000_000L
        fun check(detail: String, result: SampleResult) {
            assertTrue("expected Invalid for $detail but was $result", result is SampleResult.Invalid)
            assertEquals(detail, (result as SampleResult.Invalid).detailKey)
        }
        check(
            "tracking.tripRequired",
            TrackingCore.normalizeSample("", "c", 1.0, 1.0, now, null, now),
        )
        check(
            "tracking.idRequired",
            TrackingCore.normalizeSample("t", "", 1.0, 1.0, now, null, now),
        )
        check(
            "tracking.latRange",
            TrackingCore.normalizeSample("t", "c", 91.0, 1.0, now, null, now),
        )
        check(
            "tracking.lngRange",
            TrackingCore.normalizeSample("t", "c", 1.0, -181.0, now, null, now),
        )
        check(
            "tracking.futureTimestamp",
            TrackingCore.normalizeSample("t", "c", 1.0, 1.0, now + 60 * 60_000L, null, now),
        )
        check(
            "tracking.accuracy",
            TrackingCore.normalizeSample("t", "c", 1.0, 1.0, now, -3, now),
        )
    }

    @Test
    fun `chunkForUpload respects the server batch cap and keeps order`() {
        val samples = (1..TrackingCore.MAX_BATCH_SIZE + 1).map {
            GpsSample("c$it", "t", it.toLong(), 1.0, 1.0, null)
        }
        val batches = TrackingCore.chunkForUpload(samples)
        assertEquals(2, batches.size)
        assertEquals(TrackingCore.MAX_BATCH_SIZE, batches[0].size)
        assertEquals(1, batches[1].size)
        assertEquals("c1", batches[0].first().clientId)
        assertTrue(TrackingCore.chunkForUpload(emptyList()).isEmpty())
    }
}
