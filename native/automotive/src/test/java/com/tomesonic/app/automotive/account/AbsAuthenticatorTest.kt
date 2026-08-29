package com.tomesonic.app.automotive.account

import android.accounts.AccountManager
import android.app.Application
import android.content.Intent
import androidx.core.os.BundleCompat
import androidx.test.core.app.ApplicationProvider
import com.tomesonic.app.automotive.R
import com.tomesonic.app.automotive.ui.SignInActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.xmlpull.v1.XmlPullParser

/**
 * The AccountManager stub (ARCHITECTURE.md §6).
 *
 * One method here has behaviour and the rest are refusals, and both halves are
 * worth pinning. The behaviour — `addAccount` hands back an Intent for the
 * sign-in screen — is the ONLY thing that makes "Add account -> TomeSonic" in
 * the car's Settings reach this app; a null there is an account type that
 * silently cannot be added, which no build error and no lint check would show.
 * The refusals matter because the alternative shape (the AOSP stub's
 * `UnsupportedOperationException`) crosses a Binder into the car's Settings
 * process, and this test is where that choice is visible.
 *
 * Robolectric because Intent, Bundle, Uri and the resource table are all
 * android.jar; nothing here starts an activity or binds a service.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class)
class AbsAuthenticatorTest {

    private val context: Application = ApplicationProvider.getApplicationContext()
    private val authenticator = AbsAuthenticator(context)

    // ---- the one method with behaviour ---------------------------------------

    @Test
    fun addAccountRoutesToTheSignInActivity() {
        val bundle = authenticator.addAccount(
            null,
            AbsAuthenticator.ACCOUNT_TYPE,
            null,
            null,
            null
        )

        val intent = BundleCompat.getParcelable(bundle, AccountManager.KEY_INTENT, Intent::class.java)
        assertNotNull("addAccount must return an Intent under KEY_INTENT", intent)
        // EXPLICIT, by class: the system starts whatever this names, and an
        // implicit intent here would be resolved against every app on the head
        // unit.
        assertEquals(SignInActivity::class.java.name, intent!!.component?.className)
    }

    // ---- the refusals --------------------------------------------------------

    @Test
    fun theUnsupportedMethodsAnswerRatherThanThrow() {
        // Null is a legal "nothing to do" for these three, and a return of any
        // kind beats an exception thrown into AccountManagerService's caller.
        assertNull(authenticator.editProperties(null, AbsAuthenticator.ACCOUNT_TYPE))
        assertNull(authenticator.confirmCredentials(null, null, null))
        assertNull(authenticator.updateCredentials(null, null, null, null))
        assertNull(authenticator.getAuthTokenLabel(null))
    }

    @Test
    fun getAuthTokenDeclinesWithAReason() {
        // The ABS access token is the DataStore's and is never handed to
        // AccountManager (§6). An unexplained null would look like a bug in
        // this app to whatever asked.
        val bundle = authenticator.getAuthToken(null, null, null, null)

        assertEquals(
            AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION,
            bundle.getInt(AccountManager.KEY_ERROR_CODE)
        )
        assertNotNull(bundle.getString(AccountManager.KEY_ERROR_MESSAGE))
    }

    @Test
    fun hasFeaturesAnswersFalseInTheBundleTheCallerReads() {
        // The caller reads KEY_BOOLEAN_RESULT out of this bundle
        // unconditionally, so "no features" has to be a false, not a null.
        val bundle = authenticator.hasFeatures(null, null, arrayOf("anything"))

        assertFalse(bundle.getBoolean(AccountManager.KEY_BOOLEAN_RESULT, true))
    }

    // ---- the account type, in both places it is written ----------------------

    @Test
    fun theAccountTypeIsTheApplicationId() {
        // Not the namespace: an account type is an app-wide identity and this
        // artifact shares one with the phone build (§1).
        assertEquals("com.tomesonic.app", AbsAuthenticator.ACCOUNT_TYPE)
    }

    @Test
    fun theDescriptorDeclaresTheSameAccountType() {
        // AccountManagerService reads res/xml/authenticator.xml, NOT the
        // constant above; a drift between the two is an app whose authenticator
        // is registered under a type nothing in it ever asks for.
        assertEquals(AbsAuthenticator.ACCOUNT_TYPE, declaredAccountType())
    }

    // ---- the account row's name ----------------------------------------------

    @Test
    fun theUsernameNamesTheAccountWhenTheServerGaveOne() {
        assertEquals(
            "tony",
            AbsAuthenticator.accountName("  tony  ", "https://abs.example.com")
        )
    }

    @Test
    fun theHostNamesItWhenThereIsNoUsername() {
        // Some servers answer a login without one. An account row labelled with
        // an empty string is worse than one labelled with the address typed.
        assertEquals(
            "abs.example.com",
            AbsAuthenticator.accountName("", "https://abs.example.com:13378")
        )
        assertEquals("abs.local", AbsAuthenticator.accountName(null, "http://abs.local"))
    }

    @Test
    fun anAddressWithNoHostStillNamesTheAccount() {
        assertEquals("abs-lan", AbsAuthenticator.accountName(null, "abs-lan"))
    }

    @Test
    fun nothingToNameItAfterIsAnEmptyName() {
        // [ensure] refuses this rather than adding an unnamed row.
        assertEquals("", AbsAuthenticator.accountName(null, null))
        assertEquals("", AbsAuthenticator.accountName("   ", "   "))
    }

    // --- helpers ---

    /** `accountType` as the packaged descriptor actually declares it. */
    private fun declaredAccountType(): String? {
        val parser = context.resources.getXml(R.xml.authenticator)
        var type: String? = null
        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT) {
            if (event == XmlPullParser.START_TAG && parser.name == "account-authenticator") {
                type = parser.getAttributeValue(ANDROID_NS, "accountType")
            }
            event = parser.next()
        }
        return type
    }

    private companion object {
        const val ANDROID_NS = "http://schemas.android.com/apk/res/android"
    }
}
