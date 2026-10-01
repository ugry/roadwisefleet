package com.elilaltd.roadwisefleet.core.model

/**
 * Mirror of `apps/api/src/trip-status.js` §7 (board #103, AND1-A1).
 *
 * The API stays authoritative for status legality; this mirror exists so the
 * driver shell can render the next legal action offline. `TripCoreTest` pins
 * the two against each other, and A3 (#105) extends the server machine and this
 * mirror together — there is exactly one state machine per side.
 */
object TripStatus {
    val TRANSITIONS: Map<String, List<String>> = linkedMapOf(
        "DRAFT" to listOf("ASSIGNED", "CANCELLED"),
        "ASSIGNED" to listOf("EN_ROUTE", "LOADED", "CANCELLED"),
        "EN_ROUTE" to listOf("AT_PICKUP"),
        "AT_PICKUP" to listOf("LOADED"),
        "LOADED" to listOf("IN_TRANSIT"),
        "IN_TRANSIT" to listOf("AT_DELIVERY", "DELIVERED"),
        "AT_DELIVERY" to listOf("DELIVERED"),
        "DELIVERED" to listOf("POD_UPLOADED"),
        "POD_UPLOADED" to listOf("INVOICED"),
        "INVOICED" to listOf("SETTLED"),
        "SETTLED" to emptyList(),
        "CANCELLED" to emptyList(),
    )

    val ALL: List<String> = TRANSITIONS.keys.toList()

    /** Statuses the driver app asks the driver to confirm before sending. */
    val CONFIRM_STATUSES = listOf("DELIVERED")

    /**
     * The status Start Trip sets (board #105, AND1-A3). It is the only
     * transition that turns live GPS tracking on (`POST /api/trips/:id/start`).
     */
    const val START_TRIP_STATUS = "EN_ROUTE"

    /** Statuses in which a driver counts as actively assigned (board #105). */
    val ACTIVE_ASSIGNMENT_STATUSES = listOf(
        "ASSIGNED", "EN_ROUTE", "AT_PICKUP", "LOADED", "IN_TRANSIT", "AT_DELIVERY",
    )

    /** Mirrors `DOC_TYPES` in `apps/api/src/documents.js`. */
    val DOC_TYPES = listOf(
        "ecmr", "pod", "invoice", "driver_license", "cpc",
        "medical", "insurance", "tacho_file", "e_irsaliye",
    )

    /** These satisfy the POD_UPLOADED gate (a POD *or* an eCMR). */
    val POD_DOC_TYPES = listOf("pod", "ecmr")

    /** Document statuses that mean "the file is really there". */
    val PRESENT_DOC_STATUSES = listOf("UPLOADED", "VERIFIED")

    fun nextLegalStatuses(status: String): List<String> = TRANSITIONS[status] ?: emptyList()

    fun isTerminal(status: String): Boolean = nextLegalStatuses(status).isEmpty()

    fun requiresConfirmation(to: String): Boolean = CONFIRM_STATUSES.contains(to)

    fun isKnownStatus(status: String): Boolean = TRANSITIONS.containsKey(status)

    fun isActiveAssignment(status: String): Boolean = ACTIVE_ASSIGNMENT_STATUSES.contains(status)

    /**
     * The next driver phase for the primary action button (board #105): the
     * first legal successor that is not the CANCELLED escape hatch, or null.
     * The A1 shell showed every successor as an equal button; A3 promotes this
     * one and demotes the rest.
     */
    fun nextPhase(status: String): String? =
        nextLegalStatuses(status).firstOrNull { it != "CANCELLED" }
}
