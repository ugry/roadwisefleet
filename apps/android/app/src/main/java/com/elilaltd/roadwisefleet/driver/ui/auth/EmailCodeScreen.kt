package com.elilaltd.roadwisefleet.driver.ui.auth

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.elilaltd.roadwisefleet.core.auth.AuthRules
import com.elilaltd.roadwisefleet.core.i18n.Translator
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Enter the emailed six-digit code (board #125).
 *
 * The server answers every request generically (no account enumeration), so the
 * copy says "if this address has an account" rather than confirming the send.
 * A wrong digit keeps the driver here — the form never drops back to the
 * password screen on a failed verify — and the resend button unlocks only after
 * the server's 60 s gap, counted locally.
 *
 * All decisions (validation, the role gate, device registration) live in
 * `AuthController`; this composable owns form state only.
 */
@Composable
fun EmailCodeScreen(
    translator: Translator,
    email: String,
    noticeKey: String?,
    onVerify: suspend (code: String) -> String?,
    onResend: suspend () -> String?,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var code by rememberSaveable { mutableStateOf("") }
    var loading by remember { mutableStateOf(false) }
    var errorKey by rememberSaveable { mutableStateOf<String?>(null) }
    var resendIn by rememberSaveable { mutableIntStateOf(AuthRules.CODE_RESEND_SECONDS) }
    var resending by remember { mutableStateOf(false) }

    // The countdown restarts on every successful resend (keyed by the notice).
    LaunchedEffect(noticeKey) {
        resendIn = AuthRules.CODE_RESEND_SECONDS
        while (resendIn > 0) {
            delay(1_000)
            resendIn -= 1
        }
    }

    fun submit() {
        if (loading || !AuthRules.isCompleteCode(code)) return
        scope.launch {
            loading = true
            errorKey = null
            // Success replaces this screen with the shell; a failure is a key.
            errorKey = onVerify(AuthRules.normalizeCode(code))
            loading = false
        }
    }

    fun resend() {
        if (resending || resendIn > 0) return
        scope.launch {
            resending = true
            errorKey = null
            errorKey = onResend()
            resending = false
            code = ""
            resendIn = AuthRules.CODE_RESEND_SECONDS
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 24.dp, vertical = 32.dp),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = translator.t("brand.name"),
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.primary,
        )
        Text(
            text = translator.t("auth.otp.title"),
            style = MaterialTheme.typography.titleLarge,
            modifier = Modifier.padding(top = 8.dp),
        )
        Spacer(Modifier.height(8.dp))
        Text(
            // The address is echoed back so the driver can spot a typo; the
            // sentence never claims the account exists.
            text = translator.t("auth.otp.sentTo", mapOf("email" to email)),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        noticeKey?.let { key ->
            Spacer(Modifier.height(12.dp))
            Text(
                text = translator.t(key),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }

        Spacer(Modifier.height(24.dp))
        OutlinedTextField(
            value = code,
            onValueChange = { code = AuthRules.normalizeCode(it) },
            label = { Text(translator.t("auth.otp.codeLabel")) },
            singleLine = true,
            enabled = !loading,
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.NumberPassword,
                imeAction = ImeAction.Done,
            ),
            keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.fillMaxWidth(),
        )

        Spacer(Modifier.height(20.dp))
        Button(
            onClick = { submit() },
            enabled = !loading && AuthRules.isCompleteCode(code),
            modifier = Modifier
                .fillMaxWidth()
                .height(52.dp),
        ) {
            if (loading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(22.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
            } else {
                Text(translator.t("auth.otp.submit"))
            }
        }

        errorKey?.let { key ->
            Spacer(Modifier.height(12.dp))
            Text(
                text = translator.t(key),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            )
        }

        Spacer(Modifier.height(12.dp))
        TextButton(
            onClick = { resend() },
            enabled = !resending && resendIn == 0,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                text = if (resendIn > 0) {
                    translator.t("auth.otp.resendIn", mapOf("seconds" to resendIn.toString()))
                } else {
                    translator.t("auth.otp.resend")
                },
                textAlign = TextAlign.Center,
            )
        }

        Spacer(Modifier.height(8.dp))
        TextButton(onClick = onBack, modifier = Modifier.align(Alignment.CenterHorizontally)) {
            Text(translator.t("auth.otp.back"))
        }
    }
}
