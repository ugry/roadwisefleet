package com.elilaltd.roadwisefleet.core.data.local

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Room rows for the offline store (board #103, AND1-A1).
 *
 * A1 keeps the store intentionally flat: the per-trip document list is held as
 * a JSON string on the trip row rather than a relation table, so the schema
 * stays one migration wide while A2–A5 add their own tables. The ADR records
 * this as a deliberate trade-off with its replacement trigger.
 */
@Entity(tableName = "trips")
data class TripEntity(
    @PrimaryKey val id: String,
    val status: String,
    val origin: String?,
    val destination: String?,
    val cargo: String?,
    val customer: String?,
    val truckPlate: String?,
    val rateEur: Double?,
    val updatedAtEpochMs: Long,
    val documentsJson: String,
)

/** One queued write. `kind` is one of `OutboxKind.ALL`. */
@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val id: String,
    val kind: String,
    val tripId: String,
    val payloadJson: String,
    val createdAtEpochMs: Long,
    val attempts: Int,
    val lastError: String?,
)

/** A capture taken offline whose bytes have not been uploaded yet. */
@Entity(tableName = "pending_captures")
data class PendingCaptureEntity(
    @PrimaryKey val id: String,
    val tripId: String,
    val docType: String,
    val capturedAtEpochMs: Long?,
    val lat: Double?,
    val lng: Double?,
    val accuracyM: Int?,
    val localUri: String?,
)
