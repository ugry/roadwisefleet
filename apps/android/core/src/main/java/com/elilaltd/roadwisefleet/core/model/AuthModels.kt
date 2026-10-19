package com.elilaltd.roadwisefleet.core.model

/**
 * The signed-in user, reduced to the fields the driver app actually needs
 * (board #104 reopen). `roleId` is the server's `Role.id` — `driver` for a
 * fleet driver and `solo` for a solo driver (`solo.SOLO_ROLE` in the API).
 */
data class AuthUser(
    val id: String,
    val name: String,
    val roleId: String,
    val orgId: String?,
    val locale: String? = null,
    val lang: String? = null,
)

/** A password login: the bearer token plus the user it belongs to. */
data class PasswordLogin(
    val token: String,
    val user: AuthUser,
)
