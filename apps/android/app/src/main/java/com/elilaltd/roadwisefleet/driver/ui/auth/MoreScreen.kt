package com.elilaltd.roadwisefleet.driver.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.elilaltd.roadwisefleet.core.i18n.Translator
import com.elilaltd.roadwisefleet.core.model.AuthUser

/**
 * The More tab (board #104 reopen): the signed-in account and **Sign out**.
 *
 * Signing out is confirmed because it revokes this device — the next launch
 * needs the password again.
 */
@Composable
fun MoreScreen(
    translator: Translator,
    user: AuthUser,
    versionName: String,
    noticeKey: String?,
    onSignOut: () -> Unit,
) {
    var confirming by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier.fillMaxSize().padding(16.dp),
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
}

/** Catalogue key for the role shown under the driver's name. */
private fun roleLabelKey(roleId: String): String = when (roleId) {
    "solo", "solo_driver" -> "auth.role.solo"
    else -> "auth.role.driver"
}
