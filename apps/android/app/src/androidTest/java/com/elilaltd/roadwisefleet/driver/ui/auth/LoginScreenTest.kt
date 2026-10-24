package com.elilaltd.roadwisefleet.driver.ui.auth

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.elilaltd.roadwisefleet.core.auth.AuthRules
import com.elilaltd.roadwisefleet.core.i18n.I18n
import com.elilaltd.roadwisefleet.driver.ui.theme.RoadwiseFleetTheme
import kotlinx.coroutines.CompletableDeferred
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * AND1-QA3 (board #128) — instrumented Compose acceptance for the #104 login
 * screen, driven against the SHIPPED `LoginScreen` and the SHIPPED English
 * catalogue (so a copy change is caught here, not by a hand-written string).
 *
 * Runs on the `ci-android` instrumented job (headless AVD, API 35) — this host
 * has no emulator, so these are CI-only.
 */
@RunWith(AndroidJUnit4::class)
class LoginScreenTest {

    @get:Rule
    val compose = createComposeRule()

    private val translator = I18n.translator(
        InstrumentationRegistry.getInstrumentation().targetContext,
        "locales",
        "en",
    )

    private fun setLoginScreen(
        noticeKey: String? = null,
        emailCodeEnabled: Boolean = true,
        whatsappEnabled: Boolean = false,
        onSignIn: suspend (String, String) -> String? = { _, _ -> null },
        onRequestCode: suspend (String) -> String? = { null },
    ) {
        compose.setContent {
            RoadwiseFleetTheme {
                LoginScreen(
                    translator = translator,
                    versionName = "0.1.0-a1",
                    noticeKey = noticeKey,
                    onSignIn = onSignIn,
                    emailCodeEnabled = emailCodeEnabled,
                    onRequestCode = onRequestCode,
                    whatsappEnabled = whatsappEnabled,
                )
            }
        }
    }

    private fun emailField() = compose.onAllNodes(hasSetTextAction())[0]
    private fun passwordField() = compose.onAllNodes(hasSetTextAction())[1]

    private fun fillForm(email: String = "dana@example.com", password: String = "secret") {
        emailField().performTextInput(email)
        passwordField().performTextInput(password)
    }

    private fun waitForText(text: String) {
        compose.waitUntil(5_000L) {
            compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty()
        }
    }

    // --- fresh install -> LoginScreen (no shell) -----------------------------

    @Test
    fun freshInstall_showsLoginFormAndNoDriverShell() {
        setLoginScreen()

        compose.onNodeWithText("RoadwiseFleet").assertIsDisplayed()
        compose.onNodeWithText("Driver sign in").assertIsDisplayed()
        compose.onNodeWithText("Email").assertIsDisplayed()
        compose.onNodeWithText("Password").assertIsDisplayed()
        compose.onNodeWithText("Sign in").assertIsDisplayed()
        compose.onNodeWithText("Version 0.1.0-a1").assertIsDisplayed()

        // The shell's navigation is never composed before the gate resolves.
        for (shellLabel in listOf("Trips", "Documents", "Money", "Messages", "More")) {
            compose.onNodeWithText(shellLabel).assertDoesNotExist()
        }
    }

    @Test
    fun password_isMaskedAndCanBeRevealed() {
        setLoginScreen()

        compose.onNodeWithContentDescription("Show password").assertIsDisplayed()
        compose.onNodeWithContentDescription("Show password").performClick()

        compose.onNodeWithContentDescription("Hide password").assertIsDisplayed()
    }

    // --- invalid credentials -> inline error --------------------------------

    @Test
    fun invalidCredentials_showInlineErrorAndStayOnForm() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_INVALID })

        fillForm(password = "wrong")
        compose.onNodeWithText("Sign in").performClick()

        waitForText("Invalid email or password.")
        compose.onNodeWithText("Invalid email or password.").assertIsDisplayed()
        // Still the login form, with the fields usable for a retry.
        compose.onNodeWithText("Email").assertIsDisplayed()
        emailField().assertIsEnabled()
    }

    @Test
    fun emptySubmit_showsRequiredSentence() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_REQUIRED })

        compose.onNodeWithText("Sign in").performClick()

        waitForText("Enter your email and password.")
    }

    @Test
    fun typedValues_reachControllerUnchanged() {
        var seenEmail: String? = null
        var seenPassword: String? = null
        setLoginScreen(onSignIn = { email, password ->
            seenEmail = email
            seenPassword = password
            AuthRules.ERROR_INVALID
        })

        fillForm("  dana@example.com ", "pass word ")
        compose.onNodeWithText("Sign in").performClick()
        compose.waitForIdle()

        assertEquals("  dana@example.com ", seenEmail)
        assertEquals("pass word ", seenPassword)
    }

    @Test
    fun form_isLockedWhileSignInInFlight() {
        val gate = CompletableDeferred<String?>()
        setLoginScreen(onSignIn = { _, _ -> gate.await() })

        fillForm()
        compose.onNodeWithText("Sign in").performClick()
        compose.waitForIdle()

        // The button shows a progress indicator instead of its label, and the
        // fields are disabled so a second submit cannot race the first. A
        // disabled Compose text field exposes NO SetText action, so the
        // measurable fact is that no editable target remains.
        compose.onNodeWithText("Sign in").assertDoesNotExist()
        assertEquals(0, compose.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().size)

        gate.complete(AuthRules.ERROR_INVALID)
        waitForText("Invalid email or password.")
    }

    // --- non-driver -> refused with the fleet-web-app sentence ---------------

    @Test
    fun nonDriverRole_refusedWithFleetWebAppSentence() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_NOT_DRIVER })

        fillForm()
        compose.onNodeWithText("Sign in").performClick()

        // Exact shipped copy: the driver must be told where to go instead.
        waitForText("This account cannot use the driver app. Sign in to the fleet web app instead.")
        compose.onNodeWithText("Email").assertIsDisplayed()
    }

    // --- the other failure sentences (one per test: one setContent per test) --

    @Test
    fun lockedAccount_showsLockoutSentence() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_LOCKED })
        fillForm()
        compose.onNodeWithText("Sign in").performClick()
        waitForText("This account is locked. Contact your dispatcher.")
    }

    @Test
    fun rateLimitedLogin_showsWaitSentence() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_RATE_LIMITED })
        fillForm()
        compose.onNodeWithText("Sign in").performClick()
        waitForText("Too many attempts. Wait a minute and try again.")
    }

    @Test
    fun offlineLogin_showsConnectionSentence() {
        setLoginScreen(onSignIn = { _, _ -> AuthRules.ERROR_NETWORK })
        fillForm()
        compose.onNodeWithText("Sign in").performClick()
        waitForText("No connection. Check your internet and try again.")
    }

    // --- notice + optional affordances --------------------------------------

    @Test
    fun signInAgainNotice_shownAboveForm() {
        setLoginScreen(noticeKey = AuthRules.NOTICE_SIGN_IN_AGAIN)

        compose.onNodeWithText("Please sign in with your password.").assertIsDisplayed()
        compose.onNodeWithText("Driver sign in").assertIsDisplayed()
    }

    @Test
    fun emailCodeButton_hiddenWhenServerCannotSendMail() {
        setLoginScreen(emailCodeEnabled = false)

        compose.onNodeWithText("Email me a code instead").assertDoesNotExist()
    }

    @Test
    fun emailCodeButton_shownByDefault() {
        setLoginScreen(emailCodeEnabled = true)

        compose.onNodeWithText("Email me a code instead").assertIsDisplayed()
    }

    @Test
    fun whatsappButton_hiddenUnlessBuildFlagOn() {
        setLoginScreen(whatsappEnabled = false)

        compose.onNodeWithText("Continue with WhatsApp").assertDoesNotExist()
    }

    @Test
    fun whatsappButton_rendersWhenBuildFlagOn() {
        setLoginScreen(whatsappEnabled = true)

        compose.onNodeWithText("Continue with WhatsApp").assertIsDisplayed()
    }
}
