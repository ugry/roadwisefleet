package com.elilaltd.roadwisefleet.core.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the pure domain rules of the scaffold (board #103, AND1-A1) against the
 * pilot's `pilot/lib/driver-core.js`. Runs on the JVM (`./gradlew test`), so it
 * needs no emulator.
 */
class TripCoreTest {

    // --- trip-status mirror -------------------------------------------------

    @Test
    fun `the transition table matches the pilot`() {
        assertEquals(listOf("ASSIGNED", "CANCELLED"), TripStatus.nextLegalStatuses("DRAFT"))
        assertEquals(listOf("EN_ROUTE", "LOADED", "CANCELLED"), TripStatus.nextLegalStatuses("ASSIGNED"))
        assertEquals(listOf("AT_PICKUP"), TripStatus.nextLegalStatuses("EN_ROUTE"))
        assertEquals(listOf("LOADED"), TripStatus.nextLegalStatuses("AT_PICKUP"))
        assertEquals(listOf("IN_TRANSIT"), TripStatus.nextLegalStatuses("LOADED"))
        assertEquals(listOf("AT_DELIVERY", "DELIVERED"), TripStatus.nextLegalStatuses("IN_TRANSIT"))
        assertEquals(listOf("DELIVERED"), TripStatus.nextLegalStatuses("AT_DELIVERY"))
        assertEquals(listOf("POD_UPLOADED"), TripStatus.nextLegalStatuses("DELIVERED"))
        assertEquals(listOf("INVOICED"), TripStatus.nextLegalStatuses("POD_UPLOADED"))
        assertEquals(listOf("SETTLED"), TripStatus.nextLegalStatuses("INVOICED"))
    }

    @Test
    fun `the primary phase is the next driver phase, not the cancel escape hatch`() {
        assertEquals("EN_ROUTE", TripStatus.nextPhase("ASSIGNED"))
        assertEquals("AT_PICKUP", TripStatus.nextPhase("EN_ROUTE"))
        assertEquals("LOADED", TripStatus.nextPhase("AT_PICKUP"))
        assertEquals("IN_TRANSIT", TripStatus.nextPhase("LOADED"))
        assertEquals("AT_DELIVERY", TripStatus.nextPhase("IN_TRANSIT"))
        assertEquals("DELIVERED", TripStatus.nextPhase("AT_DELIVERY"))
        assertEquals(null, TripStatus.nextPhase("SETTLED"))
    }

    @Test
    fun `only an in-flight phase counts as an active assignment`() {
        assertTrue(TripStatus.isActiveAssignment("ASSIGNED"))
        assertTrue(TripStatus.isActiveAssignment("EN_ROUTE"))
        assertTrue(TripStatus.isActiveAssignment("AT_DELIVERY"))
        assertFalse(TripStatus.isActiveAssignment("DRAFT"))
        assertFalse(TripStatus.isActiveAssignment("DELIVERED"))
        assertFalse(TripStatus.isActiveAssignment("SETTLED"))
    }

    @Test
    fun `terminal states have no successors`() {
        assertTrue(TripStatus.isTerminal("SETTLED"))
        assertTrue(TripStatus.isTerminal("CANCELLED"))
        assertFalse(TripStatus.isTerminal("ASSIGNED"))
    }

    @Test
    fun `only DELIVERED requires a confirmation`() {
        assertTrue(TripStatus.requiresConfirmation("DELIVERED"))
        assertFalse(TripStatus.requiresConfirmation("LOADED"))
    }

    @Test
    fun `an unknown status has no successors`() {
        assertTrue(TripStatus.nextLegalStatuses("NOPE").isEmpty())
    }

    // --- documents ----------------------------------------------------------

    private fun doc(id: String, type: String, status: String) = TripDocument(id, type, status)

    @Test
    fun `a POD or an eCMR satisfies the gate`() {
        assertTrue(TripCore.podSatisfied(listOf(doc("1", "ecmr", "VERIFIED"))))
        assertTrue(TripCore.podSatisfied(listOf(doc("1", "pod", "UPLOADED"))))
        assertFalse(TripCore.podSatisfied(listOf(doc("1", "invoice", "UPLOADED"))))
    }

    @Test
    fun `a missing pod and ecmr is one outstanding requirement, not two`() {
        assertEquals(1, TripCore.requiredMissing(emptyList()))
        assertEquals(0, TripCore.requiredMissing(listOf(doc("1", "pod", "VERIFIED"))))
    }

    @Test
    fun `the checklist marks an uploaded document present`() {
        val rows = TripCore.documentChecklist(listOf(doc("7", "pod", "VERIFIED")))
        val pod = rows.first { it.docType == "pod" }
        assertTrue(pod.present)
        assertEquals("7", pod.documentId)
        assertEquals("VERIFIED", pod.status)
        val ecmr = rows.first { it.docType == "ecmr" }
        assertFalse(ecmr.present)
        assertTrue(ecmr.alternative)
    }

    @Test
    fun `POD_UPLOADED needs the transition and a present document`() {
        assertTrue(TripCore.canMarkPodUploaded("DELIVERED", listOf(doc("1", "pod", "UPLOADED"))))
        assertFalse(TripCore.canMarkPodUploaded("DELIVERED", emptyList()))
        assertFalse(TripCore.canMarkPodUploaded("IN_TRANSIT", listOf(doc("1", "pod", "UPLOADED"))))
    }

    // --- capture ------------------------------------------------------------

    @Test
    fun `a future capture timestamp is rejected`() {
        val now = 1_700_000_000_000L
        val result = TripCore.normalizeCapture(now + 48L * 60L * 60L * 1000L, null, now)
        assertEquals(CaptureResult.Invalid("capture.futureTimestamp"), result)
    }

    @Test
    fun `an out-of-range fix is rejected`() {
        val result = TripCore.normalizeCapture(null, GeoFix(lat = 91.0, lng = 0.0, accuracyM = 5), 0L)
        assertEquals(CaptureResult.Invalid("capture.geoRange"), result)
    }

    @Test
    fun `a negative accuracy is rejected`() {
        val result = TripCore.normalizeCapture(null, GeoFix(10.0, 20.0, -1), 0L)
        assertEquals(CaptureResult.Invalid("capture.accuracy"), result)
    }

    @Test
    fun `a missing fix is valid and leaves the geometry null`() {
        val result = TripCore.normalizeCapture(1234L, null, 0L)
        assertTrue(result is CaptureResult.Ok)
        assertEquals(CaptureMeta(1234L, null, null, null), (result as CaptureResult.Ok).value)
    }

    // --- outbox planner -----------------------------------------------------

    private fun item(id: String, at: Long) =
        OutboxItem(id = id, kind = OutboxKind.STATUS, tripId = "t1", payloadJson = "{}", createdAtEpochMs = at)

    @Test
    fun `offline defers the whole queue in order`() {
        val plan = TripCore.planQueueSync(listOf(item("b", 2), item("a", 1)), online = false)
        assertFalse(plan.online)
        assertTrue(plan.send.isEmpty())
        assertEquals(listOf("a", "b"), plan.deferred.map { it.id })
    }

    @Test
    fun `online sends the whole queue oldest first`() {
        val plan = TripCore.planQueueSync(listOf(item("b", 2), item("a", 1)), online = true)
        assertTrue(plan.online)
        assertEquals(listOf("a", "b"), plan.send.map { it.id })
    }

    @Test
    fun `failure classification retries the transient and drops the permanent`() {
        assertEquals(FailureClass.RETRY, TripCore.classifyFailure(null))
        assertEquals(FailureClass.RETRY, TripCore.classifyFailure(500))
        assertEquals(FailureClass.RETRY, TripCore.classifyFailure(429))
        assertEquals(FailureClass.RETRY, TripCore.classifyFailure(408))
        assertEquals(FailureClass.DROP, TripCore.classifyFailure(404))
        assertEquals(FailureClass.DROP, TripCore.classifyFailure(422))
    }

    @Test
    fun `the fold removes sent and dropped items and bumps retried ones`() {
        val items = listOf(item("ok", 1), item("retry", 2), item("drop", 3))
        val fold = TripCore.applySyncResults(
            items,
            listOf(
                SendResult("ok", ok = true),
                SendResult("retry", ok = false, status = 503),
                SendResult("drop", ok = false, status = 422),
            ),
        )
        assertEquals(listOf("ok"), fold.sent)
        assertEquals(listOf("retry"), fold.retried)
        assertEquals(listOf("drop"), fold.dropped.map { it.id })
        assertEquals(listOf("retry"), fold.queue.map { it.id })
        assertEquals(1, fold.queue.first().attempts)
    }

    @Test
    fun `the sync indicator prefers syncing over offline and error`() {
        assertEquals(SyncState.SYNCING, TripCore.syncIndicator(2, online = false, syncing = true, lastError = "x").state)
        assertEquals(SyncState.OFFLINE, TripCore.syncIndicator(2, online = false, syncing = false, lastError = null).state)
        assertEquals(SyncState.ERROR, TripCore.syncIndicator(2, online = true, syncing = false, lastError = "x").state)
        assertEquals(SyncState.PENDING, TripCore.syncIndicator(2, online = true, syncing = false, lastError = null).state)
        assertEquals(SyncState.SYNCED, TripCore.syncIndicator(0, online = true, syncing = false, lastError = null).state)
    }
}
