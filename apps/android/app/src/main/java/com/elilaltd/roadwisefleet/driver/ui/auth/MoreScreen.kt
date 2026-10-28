package com.elilaltd.roadwisefleet.driver.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.elilaltd.roadwisefleet.core.auth.AuthRules
import com.elilaltd.roadwisefleet.core.i18n.Translator
import com.elilaltd.roadwisefleet.core.model.AuthUser
import kotlinx.coroutines.launch

/**
 * The More tab (board #104 reopen): the signed-in account, **Sign out**, and the
 * Play-required **Delete account** entry (board #142, AND1-A3).
 *
 * Signing out is confirmed because it revokes this device — the next launch
 * needs the password again.
 *
 * Deletion is deliberately harder to reach than sign-out: the driver must open
 * the dialog, read what is deleted and what is kept, and TYPE the confirmation
 * word before the destructive button arms. Google Play requires an in-app
 * deletion path with a real confirmation, and this is it; the same endpoint is
 * also reachable on the web at roadwisefleet.com/delete-account/ so somebody
 * who has lost the phone can still delete the account.
 */
@Composable
fun MoreScreen(
    translator: Translator,
    user: AuthUser,
    versionName: String,
    noticeKey: String?,
    onSignOut: () -> Unit,
    onDeleteAccount: suspend () -> String?,
) {
    var confirming by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    var typedConfirmation by remember { mutableStateOf("") }
    var deleting by remember { mutableStateOf(false) }
    var deleteErrorKey by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(translator.t("nav.more"), style = MaterialTheme.typography.headlineSmall)

        noticeKey?.let { key ->
            Text(
                text = translator.t(key),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }

        Card(modifier = Modifier.fillMaxWidth()) {
            Column(
                modifier = Modifier.padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                Text(
                    text = translator.t("common.signedInAs"),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = user.name.ifBlank { user.id },
                    style = MaterialTheme.typography.titleMedium,
                )
                Text(
                    text = translator.t(roleLabelKey(user.roleId)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        Text(
            text = translator.t("driver.shell.more.body"),
            style = MaterialTheme.typography.bodyMedium,
        )

        Spacer(Modifier.height(4.dp))
        OutlinedButton(
            onClick = { confirming = true },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(translator.t("common.signOut"))
        }

        Spacer(Modifier.height(12.dp))
        Text(
            text = translator.t("auth.deleteAccount.section"),
            style = MaterialTheme.typography.titleSmall,
        )
        Text(
            text = translator.t("auth.deleteAccount.sectionBody"),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        deleteErrorKey?.let { key ->
            Text(
                text = translator.t(key),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
            )
        }
        OutlinedButton(
            onClick = {
                typedConfirmation = ""
                deleteErrorKey = null
                confirmingDelete = true
            },
            enabled = !deleting,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
        ) {
            Text(translator.t("auth.deleteAccount.open"))
        }

        Text(
            text = translator.t("auth.version", mapOf("version" to versionName)),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (confirming) {
        AlertDialog(
            onDismissRequest = { confirming = false },
            title = { Text(translator.t("auth.signOut.title")) },
            text = { Text(translator.t("auth.signOut.body")) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = false
                        onSignOut()
                    },
                ) { Text(translator.t("common.signOut")) }
            },
            dismissButton = {
                TextButton(onClick = { confirming = false }) {
                    Text(translator.t("common.cancel"))
                }
            },
        )
    }

    if (confirmingDelete) {
        val armed = AuthRules.deleteConfirmationMatches(typedConfirmation)
        AlertDialog(
            onDismissRequest = { if (!deleting) confirmingDelete = false },
            title = { Text(translator.t("auth.deleteAccount.title")) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(translator.t("auth.deleteAccount.body"))
                    Text(
                        text = translator.t("auth.deleteAccount.retained"),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    OutlinedTextField(
                        value = typedConfirmation,
                        onValueChange = { typedConfirmation = it },
                        singleLine = true,
                        enabled = !deleting,
                        label = { Text(translator.t("auth.deleteAccount.confirmLabel")) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        scope.launch {
                            deleting = true
                            // On success the controller moves the app to the login
                            // screen; a failure keeps us here with the sentence.
                            val failure = onDeleteAccount()
                            deleting = false
                            confirmingDelete = false
                            deleteErrorKey = failure
                        }
                    },
                    // Fail-closed: the destructive action is unreachable until the
                    // driver types the word, and it cannot be double-submitted.
                    enabled = armed && !deleting,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.error,
                        contentColor = MaterialTheme.colorScheme.onError,
                    ),
                ) {
                    Text(translator.t("auth.deleteAccount.confirm"))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = false }, enabled = !deleting) {
                    Text(translator.t("common.cancel"))
                }
            },
        )
    }
}

/** Catalogue key for the role shown under the driver's name. */
private fun roleLabelKey(roleId: String): String = when (roleId) {
    "solo", "solo_driver" -> "auth.role.solo"
    else -> "auth.role.driver"
}
