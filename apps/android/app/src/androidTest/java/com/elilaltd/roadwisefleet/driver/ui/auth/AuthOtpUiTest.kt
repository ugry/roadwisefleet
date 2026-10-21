package com.elilaltd.roadwisefleet.driver.ui.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.elilaltd.roadwisefleet.driver.di.AppContainer
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Board #125 — the passwordless sign-in UI gate.
 *
 * The OTP endpoints and the controller are unit-tested; these two composables
 * were only covered by reading. What the acceptance actually pins is UI:
 *   1. "Continue with WhatsApp" is NOT composed while the provider flag is off
 *      (the default) — it may not appear before #124 enables it;
 *   2. "Email me a code" appears only when the server reports a working sender,
 *      and asks for the address the driver typed;
 *   3. the code form takes six digits only, keeps the driver on the form after a
 *      wrong code, shows the resend countdown instead of an armed button, and
 *      swaps the submit label for a spinner while a verify is in flight.
 *
 * Method names are underscored because the minSdk 24 DEX level rejects space
 * characters in simple names (D8, board #114); the human label is the comment.
 */
@RunWith(AndroidJUnit4::class)
class AuthOtpUiTest {

    @get:Rule
    val composeRule = createComposeRule()

    private lateinit var container: AppContainer
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val translator get() = container.localeController.translator()

    @Before
    fun setUp() {
        container = AppContainer(context)
    }

    private fun renderLogin(
        emailCodeEnabled: Boolean = true,
        whatsappEnabled: Boolean? = null,
        onRequestCode: suspend (String) -> String? = { null },
        onWhatsApp: () -> Unit = {},
    ) {
        composeRule.setContent {
            if (whatsappEnabled == null) {
                // No whatsapp argument: the composable's own default must stay off.
                LoginScreen(
                    translator = translator,
                    versionName = "0.1.0-test",
                    noticeKey = null,
                    onSignIn = { _, _ -> null },
                    emailCodeEnabled = emailCodeEnabled,
                    onRequestCode = onRequestCode,
                )
            } else {
                LoginScreen(
                    translator = translator,
                    versionName = "0.1.0-test",
                    noticeKey = null,
                    onSignIn = { _, _ -> null },
                    emailCodeEnabled = emailCodeEnabled,
                    onRequestCode = onRequestCode,
                    whatsappEnabled = whatsappEnabled,
                    onWhatsApp = onWhatsApp,
                )
            }
        }
    }

    private fun renderCode(
        onVerify: suspend (String) -> String? = { null },
        onResend: suspend () -> String? = { null },
    ) {
        composeRule.setContent {
            EmailCodeScreen(
                translator = translator,
                email = "driver@example.com",
                noticeKey = null,
                onVerify = onVerify,
                onResend = onResend,
                onBack = {},
            )
        }
    }

    private fun typeEmail(address: String) {
        composeRule.onAllNodes(hasSetTextAction())[0].performTextInput(address)
    }

    @Test
    // Human label: the default build does not compose the WhatsApp button.
    fun the_whatsapp_button_is_absent_at_the_composable_default() {
        renderLogin()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(translator.t("auth.otp.useWhatsApp")).assertDoesNotExist()
        // The email-code path is not collateral damage of the hidden button.
        composeRule.onNodeWithText(translator.t("auth.otp.useEmailCode")).assertIsDisplayed()
    }

    @Test
    // Human label: with the provider flag on, the button is composed and wired.
    fun the_whatsapp_button_is_composed_and_actionable_when_the_flag_is_on() {
        var taps = 0
        renderLogin(whatsappEnabled = true, onWhatsApp = { taps += 1 })
        composeRule.waitForIdle()

        composeRule.onNodeWithText(translator.t("auth.otp.useWhatsApp")).assertIsDisplayed().performClick()
        composeRule.waitForIdle()
        assertEquals("the WhatsApp button must call the provider hook once", 1, taps)
    }

    @Test
    // Human label: no sender configured means no email-code button.
    fun the_email_code_button_is_hidden_when_the_server_has_no_sender() {
        renderLogin(emailCodeEnabled = false)
        composeRule.waitForIdle()

        composeRule.onNodeWithText(translator.t("auth.otp.useEmailCode")).assertDoesNotExist()
    }

    @Test
    // Human label: the button requests a code for the address the driver typed.
    fun the_email_code_button_requests_a_code_for_the_typed_address() {
        var requested: String? = null
        renderLogin(onRequestCode = { address -> requested = address; null })

        composeRule.waitForIdle()
        typeEmail("driver@example.com")
        composeRule.onNodeWithText(translator.t("auth.otp.useEmailCode")).performClick()
        composeRule.waitForIdle()

        assertEquals("driver@example.com", requested)
    }

    @Test
    // Human label: a shorter-than-six-digit code cannot be submitted.
    fun the_code_form_enables_submit_only_at_six_digits() {
        renderCode()
        composeRule.waitForIdle()

        val submit = translator.t("auth.otp.submit")
        composeRule.onNodeWithText(submit).assertIsNotEnabled()

        composeRule.onAllNodes(hasSetTextAction())[0].performTextInput("12345")
        composeRule.waitForIdle()
        composeRule.onNodeWithText(submit).assertIsNotEnabled()

        // Seven characters, two of them non-digits: normalised to six, so armed.
        composeRule.onAllNodes(hasSetTextAction())[0].performTextReplacement("12a34-567")
        composeRule.waitForIdle()
        composeRule.onNodeWithText(submit).assertIsEnabled()
    }

    @Test
    // Human label: a wrong code shows the error and keeps the driver on the form.
    fun a_wrong_code_is_reported_without_leaving_the_form() {
        renderCode(onVerify = { "auth.otp.error.code" })
        composeRule.waitForIdle()

        composeRule.onAllNodes(hasSetTextAction())[0].performTextInput("123456")
        composeRule.onNodeWithText(translator.t("auth.otp.submit")).performClick()
        composeRule.waitForIdle()

        composeRule.onNodeWithText(translator.t("auth.otp.error.code")).assertIsDisplayed()
        composeRule.onNodeWithText(translator.t("auth.otp.submit")).assertIsDisplayed()
        // Still exactly one code field: the form was not swapped for the login screen.
        // (The label text is matched twice — the field node merges its own label —
        // so count the editable nodes instead of matching the label.)
        composeRule.onAllNodes(hasSetTextAction()).assertCountEquals(1)
    }

    @Test
    // Human label: the resend control counts down and is not armed while counting.
    fun resend_counts_down_before_it_can_be_used() {
        var resends = 0
        renderCode(onResend = { resends += 1; null })
        composeRule.waitForIdle()

        // Build the prefix from the catalogue so the test follows the locale
        // instead of hardcoding English ("Send a new code in {seconds}s").
        val countdownPrefix = translator
            .t("auth.otp.resendIn", mapOf("seconds" to "|"))
            .substringBefore("|")
        composeRule.onNodeWithText(countdownPrefix, substring = true)
            .assertIsDisplayed()
            .assertIsNotEnabled()
        // The armed label ("Send a new code") is not the one on screen.
        composeRule.onNodeWithText(translator.t("auth.otp.resend")).assertDoesNotExist()
        composeRule.waitForIdle()

        assertEquals("resend must stay unarmed during the 60 s countdown", 0, resends)
    }

    @Test
    // Human label: an in-flight verify swaps the label for a spinner.
    fun an_in_flight_verify_shows_the_loading_state() {
        val pending = CompletableDeferred<String?>()
        renderCode(onVerify = { pending.await() })
        composeRule.waitForIdle()

        composeRule.onAllNodes(hasSetTextAction())[0].performTextInput("123456")
        composeRule.onNodeWithText(translator.t("auth.otp.submit")).performClick()
        composeRule.waitForIdle()

        // The submit label is replaced by the progress indicator while awaiting.
        composeRule.onNodeWithText(translator.t("auth.otp.submit")).assertDoesNotExist()

        pending.complete("auth.otp.error.code")
        composeRule.waitForIdle()
        composeRule.onNodeWithText(translator.t("auth.otp.error.code")).assertIsDisplayed()
    }
}
