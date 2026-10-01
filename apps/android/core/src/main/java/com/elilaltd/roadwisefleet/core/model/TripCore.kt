package com.elilaltd.roadwisefleet.core.model

/** How a failed send should be treated on the next sync. */
enum class FailureClass { RETRY, DROP }

/** The sync chip state — mirrors `driver-core.js#syncIndicator`. */
enum class SyncState { SYNCING, OFFLINE, ERROR, PENDING, SYNCED }

data class SyncIndicator(val state: SyncState, val pending: Int, val labelKey: String)

/** What to send now; [deferred] keeps a trip's changes in order while offline. */
data class QueuePlan(val online: Boolean, val send: List<OutboxItem>, val deferred: List<OutboxItem>)

/** One send outcome, as reported by the sync engine. */
data class SendResult(val id: String, val ok: Boolean, val status: Int? = null, val error: String? = null)

/** The queue after folding send results back in. */
data class SyncFold(
    val queue: List<OutboxItem>,
    val sent: List<String>,
    val dropped: List<SendResult>,
    val retried: List<String>,
)

/**
 * The pure offline/capture rules, mirrors of `pilot/lib/driver-core.js`
 * (board #103, AND1-A1). No Android types, no JSON — so the JVM unit tests in
 * `core/src/test` run without a device and A1's behaviour is pinned.
 */
object TripCore {
    /** Weight given to a capture's accuracy when judging it usable. */
    const val MAX_USABLE_ACCURACY_M = 2000

    private val PERMANENT_HTTP = setOf(400, 401, 403, 404, 409, 413, 415, 422)

    /** One requirement per group: the trip needs at least one document from each. */
    private val REQUIRED_GROUPS = listOf(TripStatus.POD_DOC_TYPES)

    private val CHECKLIST = listOf(
        ChecklistRow("pod", "doctype.pod", "doctype.pod.hint", true, false, false, null, null),
        ChecklistRow("ecmr", "doctype.ecmr", "doctype.ecmr.hint", true, true, false, null, null),
        ChecklistRow("e_irsaliye", "doctype.e_irsaliye", "doctype.e_irsaliye.hint", false, false, false, null, null),
        ChecklistRow("invoice", "doctype.invoice", "doctype.invoice.hint", false, false, false, null, null),
        ChecklistRow("tacho_file", "doctype.tacho_file", "doctype.tacho_file.hint", false, false, false, null, null),
    )

    fun hasPresentDocument(documents: List<TripDocument>, docType: String): Boolean =
        documents.any { it.docType == docType && TripStatus.PRESENT_DOC_STATUSES.contains(it.status) }

    /** A missing POD *and* eCMR is one outstanding requirement, not two. */
    fun requiredMissing(documents: List<TripDocument>): Int =
        REQUIRED_GROUPS.count { group -> group.none { hasPresentDocument(documents, it) } }

    fun podSatisfied(documents: List<TripDocument>): Boolean =
        TripStatus.POD_DOC_TYPES.any { hasPresentDocument(documents, it) }

    fun canMarkPodUploaded(status: String, documents: List<TripDocument>): Boolean =
        TripStatus.nextLegalStatuses(status).contains("POD_UPLOADED") && podSatisfied(documents)

    /** The checklist rows for one trip, with the latest document per type. */
    fun documentChecklist(documents: List<TripDocument>): List<ChecklistRow> =
        CHECKLIST.map { row ->
            val match = documents.lastOrNull { it.docType == row.docType }
            val status = match?.status?.takeIf { it.isNotBlank() }
            row.copy(
                present = status != null && TripStatus.PRESENT_DOC_STATUSES.contains(status),
                status = status,
                documentId = match?.id,
            )
        }

    /**
     * Validate the capture metadata a POD upload carries. GPS is best-effort:
     * a missing fix is valid (all nulls), a malformed one is rejected, and a
     * timestamp in the future is a clock problem the driver should see.
     */
    fun normalizeCapture(capturedAtEpochMs: Long?, geo: GeoFix?, nowEpochMs: Long): CaptureResult {
        if (capturedAtEpochMs != null && capturedAtEpochMs > nowEpochMs + 24L * 60L * 60L * 1000L) {
            return CaptureResult.Invalid("capture.futureTimestamp")
        }
        if (geo == null) return CaptureResult.Ok(CaptureMeta(capturedAtEpochMs, null, null, null))
        if (geo.lat < -90.0 || geo.lat > 90.0 || geo.lng < -180.0 || geo.lng > 180.0) {
            return CaptureResult.Invalid("capture.geoRange")
        }
        val accuracy = geo.accuracyM
        if (accuracy != null && accuracy < 0) return CaptureResult.Invalid("capture.accuracy")
        return CaptureResult.Ok(CaptureMeta(capturedAtEpochMs, geo.lat, geo.lng, accuracy))
    }

    /** Oldest first — a trip's changes must replay in the order they happened. */
    fun sortQueue(items: List<OutboxItem>): List<OutboxItem> =
        items.sortedWith(compareBy({ it.createdAtEpochMs }, { it.id }))

    fun planQueueSync(items: List<OutboxItem>, online: Boolean): QueuePlan {
        val queue = sortQueue(items)
        return if (!online) QueuePlan(false, emptyList(), queue) else QueuePlan(true, queue, emptyList())
    }

    /** Network errors and 5xx/429/408 retry; a 4xx is a permanent drop. */
    fun classifyFailure(status: Int?): FailureClass {
        if (status == null) return FailureClass.RETRY
        if (status == 408 || status == 429) return FailureClass.RETRY
        if (status >= 500) return FailureClass.RETRY
        if (PERMANENT_HTTP.contains(status)) return FailureClass.DROP
        return if (status >= 400 && status < 500) FailureClass.DROP else FailureClass.RETRY
    }

    /** Successes leave the queue; permanent failures leave it and are reported. */
    fun applySyncResults(items: List<OutboxItem>, results: List<SendResult>): SyncFold {
        val byId = results.associateBy { it.id }
        val keep = mutableListOf<OutboxItem>()
        val sent = mutableListOf<String>()
        val dropped = mutableListOf<SendResult>()
        val retried = mutableListOf<String>()
        for (item in items) {
            val result = byId[item.id] ?: run { keep.add(item); continue }
            when {
                result.ok -> sent.add(item.id)
                classifyFailure(result.status) == FailureClass.DROP -> dropped.add(result)
                else -> {
                    keep.add(item.copy(attempts = item.attempts + 1, lastError = result.error))
                    retried.add(item.id)
                }
            }
        }
        return SyncFold(keep, sent, dropped, retried)
    }

    fun syncIndicator(pending: Int, online: Boolean, syncing: Boolean, lastError: String?): SyncIndicator = when {
        syncing -> SyncIndicator(SyncState.SYNCING, pending, "driver.sync.syncing")
        !online -> SyncIndicator(SyncState.OFFLINE, pending, "driver.sync.offline")
        lastError != null -> SyncIndicator(SyncState.ERROR, pending, "driver.sync.error")
        pending > 0 -> SyncIndicator(SyncState.PENDING, pending, "driver.sync.pending")
        else -> SyncIndicator(SyncState.SYNCED, 0, "driver.sync.synced")
    }
}
