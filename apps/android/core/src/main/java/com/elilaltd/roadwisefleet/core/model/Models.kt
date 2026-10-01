package com.elilaltd.roadwisefleet.core.model

/** One trip as the driver app stores and shows it. */
data class Trip(
    val id: String,
    val status: String,
    val origin: String?,
    val destination: String?,
    val cargo: String?,
    val customer: String?,
    val truckPlate: String?,
    val rateEur: Double?,
    val updatedAtEpochMs: Long,
    val documents: List<TripDocument> = emptyList(),
) {
    val routeLabel: String
        get() = listOfNotNull(origin, destination).joinToString(" → ").ifBlank { id }
}

/** One document attached to a trip. */
data class TripDocument(
    val id: String,
    val docType: String,
    val status: String,
    val uploadedAtEpochMs: Long? = null,
)

/** A GPS fix, straight from the platform location API. */
data class GeoFix(
    val lat: Double,
    val lng: Double,
    val accuracyM: Int?,
)

/** The validated metadata a POD capture carries. */
data class CaptureMeta(
    val capturedAtEpochMs: Long?,
    val lat: Double?,
    val lng: Double?,
    val accuracyM: Int?,
)

/** Capture validation result — mirrors `driver-core.js#normalizeCapture`. */
sealed interface CaptureResult {
    data class Ok(val value: CaptureMeta) : CaptureResult
    /** [detailKey] is a catalogue key (e.g. `capture.geoRange`). */
    data class Invalid(val detailKey: String) : CaptureResult
}

/** The offline queue. `kind` is one of [OutboxKind]. */
data class OutboxItem(
    val id: String,
    val kind: String,
    val tripId: String,
    val payloadJson: String,
    val createdAtEpochMs: Long,
    val attempts: Int = 0,
    val lastError: String? = null,
)

object OutboxKind {
    const val STATUS = "status"
    const val DOCUMENT = "document"
    const val SOS = "sos"
    val ALL = listOf(STATUS, DOCUMENT, SOS)
}

/** One checklist row — mirrors `driver-core.js#documentChecklist`. */
data class ChecklistRow(
    val docType: String,
    val labelKey: String,
    val hintKey: String,
    val required: Boolean,
    val alternative: Boolean,
    val present: Boolean,
    val status: String?,
    val documentId: String?,
)
