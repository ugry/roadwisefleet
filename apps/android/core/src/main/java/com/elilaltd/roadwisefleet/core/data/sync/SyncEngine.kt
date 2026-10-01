package com.elilaltd.roadwisefleet.core.data.sync

import com.elilaltd.roadwisefleet.core.data.local.OutboxDao
import com.elilaltd.roadwisefleet.core.data.local.OutboxEntity
import com.elilaltd.roadwisefleet.core.data.remote.ApiClient
import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.model.OutboxItem
import com.elilaltd.roadwisefleet.core.model.OutboxKind
import com.elilaltd.roadwisefleet.core.model.SendResult
import com.elilaltd.roadwisefleet.core.model.SyncFold
import com.elilaltd.roadwisefleet.core.model.SyncState
import com.elilaltd.roadwisefleet.core.model.TripCore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/**
 * Drains the outbox (board #103, AND1-A1). The decision logic is the pure
 * [TripCore] planner/fold; this class owns the IO and the scheduling.
 *
 * A1 starts the engine from the Application process with a network callback and
 * a periodic retry. A3 (#105) gates the *tracking* side with the trip's
 * `tracking` flag; the queue itself is not a location publisher.
 */
class SyncEngine(
    private val api: ApiClient,
    private val outboxDao: OutboxDao,
    private val connectivity: ConnectivityObserver,
    private val scope: CoroutineScope,
    private val retryIntervalMs: Long = 60_000L,
) {
    private val mutex = Mutex()
    private val _state = MutableStateFlow(SyncState.SYNCED)
    val state: StateFlow<SyncState> = _state.asStateFlow()

    fun start() {
        scope.launch {
            connectivity.observe().collect { online ->
                if (online) syncNow()
            }
        }
        scope.launch {
            while (isActive) {
                delay(retryIntervalMs)
                if (connectivity.isOnline()) syncNow()
            }
        }
    }

    /**
     * Send everything queued, oldest first, and fold the results back into the
     * queue. Returns null when there was nothing to send or the device is
     * offline (the [state] still reflects reality).
     */
    suspend fun syncNow(): SyncFold? = mutex.withLock {
        val items = outboxDao.all().map(::toItem)
        if (items.isEmpty()) {
            _state.value = SyncState.SYNCED
            return@withLock null
        }
        if (!connectivity.isOnline()) {
            _state.value = SyncState.OFFLINE
            return@withLock null
        }
        _state.value = SyncState.SYNCING
        val fold = TripCore.applySyncResults(items, items.map { send(it) })

        val keptIds = fold.queue.map { it.id }.toSet()
        for (item in items) {
            if (!keptIds.contains(item.id)) outboxDao.delete(item.id)
        }
        for (item in fold.queue) {
            outboxDao.update(item.id, item.attempts, item.lastError)
        }
        _state.value = when {
            fold.dropped.isNotEmpty() -> SyncState.ERROR
            fold.queue.isEmpty() -> SyncState.SYNCED
            else -> SyncState.PENDING
        }
        fold
    }

    private suspend fun send(item: OutboxItem): SendResult = when (item.kind) {
        OutboxKind.STATUS -> result(item.id, api.postStatus(item.tripId, statusFrom(item.payloadJson)))
        OutboxKind.DOCUMENT -> result(item.id, api.postDocument(item.tripId, item.payloadJson))
        OutboxKind.SOS -> result(item.id, api.postSos(item.payloadJson))
        else -> SendResult(item.id, ok = false, status = null, error = "unknown_kind")
    }

    private fun result(id: String, outcome: ApiResult<Unit>): SendResult = when (outcome) {
        is ApiResult.Ok -> SendResult(id, ok = true)
        is ApiResult.HttpFailure -> SendResult(id, ok = false, status = outcome.status, error = outcome.error)
        is ApiResult.NetworkFailure -> SendResult(id, ok = false, status = null, error = outcome.message)
    }

    private fun statusFrom(payloadJson: String): String =
        runCatching { JSONObject(payloadJson).optString("status") }.getOrDefault("")

    private fun toItem(entity: OutboxEntity): OutboxItem = OutboxItem(
        id = entity.id,
        kind = entity.kind,
        tripId = entity.tripId,
        payloadJson = entity.payloadJson,
        createdAtEpochMs = entity.createdAtEpochMs,
        attempts = entity.attempts,
        lastError = entity.lastError,
    )
}
