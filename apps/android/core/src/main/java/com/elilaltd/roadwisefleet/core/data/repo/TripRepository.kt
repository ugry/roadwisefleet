package com.elilaltd.roadwisefleet.core.data.repo

import com.elilaltd.roadwisefleet.core.data.local.OutboxDao
import com.elilaltd.roadwisefleet.core.data.local.OutboxEntity
import com.elilaltd.roadwisefleet.core.data.local.TripDao
import com.elilaltd.roadwisefleet.core.data.local.TripEntity
import com.elilaltd.roadwisefleet.core.data.remote.ApiClient
import com.elilaltd.roadwisefleet.core.data.remote.ApiResult
import com.elilaltd.roadwisefleet.core.data.remote.map
import com.elilaltd.roadwisefleet.core.model.OutboxItem
import com.elilaltd.roadwisefleet.core.model.OutboxKind
import com.elilaltd.roadwisefleet.core.model.Trip
import com.elilaltd.roadwisefleet.core.model.TripDocument
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * The write path is always local-first (board #103, AND1-A1): every driver
 * action is written to the outbox and the sync engine replays it when there is
 * signal. Reads come from Room, so the shell is useful offline once loaded.
 */
class TripRepository(
    private val api: ApiClient,
    private val tripDao: TripDao,
    private val outboxDao: OutboxDao,
) {
    fun observeTrips(): Flow<List<Trip>> = tripDao.observeAll().map { rows -> rows.map(::toTrip) }

    fun observeOutbox(): Flow<List<OutboxItem>> = outboxDao.observeAll().map { rows -> rows.map(::toItem) }

    /** Pull the driver's trips into the store; returns the row count on success. */
    suspend fun refresh(): ApiResult<Int> =
        api.driverTrips().map { trips ->
            tripDao.upsertAll(trips.map(::toEntity))
            trips.size
        }

    suspend fun enqueueStatus(tripId: String, to: String, nowMs: Long = System.currentTimeMillis()) {
        outboxDao.insert(
            OutboxEntity(
                id = UUID.randomUUID().toString(),
                kind = OutboxKind.STATUS,
                tripId = tripId,
                payloadJson = JSONObject().put("status", to).toString(),
                createdAtEpochMs = nowMs,
                attempts = 0,
                lastError = null,
            ),
        )
    }

    /**
     * Queue Start Trip (board #105): the dedicated action that moves the trip
     * ASSIGNED → EN_ROUTE and turns live GPS tracking on. `POST
     * /api/trips/:id/start` takes no body (the id is in the path), so the queue
     * replays it like any other write.
     */
    suspend fun enqueueStart(tripId: String, nowMs: Long = System.currentTimeMillis()) {
        outboxDao.insert(
            OutboxEntity(
                id = UUID.randomUUID().toString(),
                kind = OutboxKind.START,
                tripId = tripId,
                payloadJson = "{}",
                createdAtEpochMs = nowMs,
                attempts = 0,
                lastError = null,
            ),
        )
    }

    suspend fun enqueueDocument(
        tripId: String,
        docType: String,
        capturedAtEpochMs: Long?,
        lat: Double?,
        lng: Double?,
        accuracyM: Int?,
        localUri: String?,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val payload = JSONObject()
            .put("docType", docType)
            .put("capturedAt", capturedAtEpochMs ?: JSONObject.NULL)
            .put("localUri", localUri ?: JSONObject.NULL)
        if (lat != null && lng != null) {
            payload.put(
                "geo",
                JSONObject().put("lat", lat).put("lng", lng).put("accuracy", accuracyM ?: JSONObject.NULL),
            )
        }
        outboxDao.insert(
            OutboxEntity(
                id = UUID.randomUUID().toString(),
                kind = OutboxKind.DOCUMENT,
                tripId = tripId,
                payloadJson = payload.toString(),
                createdAtEpochMs = nowMs,
                attempts = 0,
                lastError = null,
            ),
        )
    }

    suspend fun enqueueSos(tripId: String, message: String, nowMs: Long = System.currentTimeMillis()) {
        outboxDao.insert(
            OutboxEntity(
                id = UUID.randomUUID().toString(),
                kind = OutboxKind.SOS,
                tripId = tripId,
                payloadJson = JSONObject().put("tripId", tripId).put("message", message).toString(),
                createdAtEpochMs = nowMs,
                attempts = 0,
                lastError = null,
            ),
        )
    }

    private fun toTrip(entity: TripEntity): Trip = Trip(
        id = entity.id,
        status = entity.status,
        origin = entity.origin,
        destination = entity.destination,
        cargo = entity.cargo,
        customer = entity.customer,
        truckPlate = entity.truckPlate,
        rateEur = entity.rateEur,
        updatedAtEpochMs = entity.updatedAtEpochMs,
        documents = parseDocuments(entity.documentsJson),
    )

    private fun toEntity(trip: Trip): TripEntity = TripEntity(
        id = trip.id,
        status = trip.status,
        origin = trip.origin,
        destination = trip.destination,
        cargo = trip.cargo,
        customer = trip.customer,
        truckPlate = trip.truckPlate,
        rateEur = trip.rateEur,
        updatedAtEpochMs = trip.updatedAtEpochMs,
        documentsJson = documentsToJson(trip.documents),
    )

    private fun toItem(entity: OutboxEntity): OutboxItem = OutboxItem(
        id = entity.id,
        kind = entity.kind,
        tripId = entity.tripId,
        payloadJson = entity.payloadJson,
        createdAtEpochMs = entity.createdAtEpochMs,
        attempts = entity.attempts,
        lastError = entity.lastError,
    )

    private fun documentsToJson(documents: List<TripDocument>): String {
        val array = JSONArray()
        documents.forEach { document ->
            array.put(
                JSONObject()
                    .put("id", document.id)
                    .put("docType", document.docType)
                    .put("status", document.status),
            )
        }
        return array.toString()
    }

    private fun parseDocuments(json: String): List<TripDocument> = runCatching {
        val array = JSONArray(json)
        (0 until array.length()).mapNotNull { index ->
            array.optJSONObject(index)?.let { document ->
                TripDocument(
                    id = document.optString("id"),
                    docType = document.optString("docType"),
                    status = document.optString("status"),
                )
            }
        }
    }.getOrDefault(emptyList())
}
