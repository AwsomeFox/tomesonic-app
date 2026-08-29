package com.tomesonic.app.automotive.account

import android.accounts.AbstractAccountAuthenticator
import android.accounts.Account
import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.tomesonic.app.automotive.ui.SignInActivity

/**
 * The car's AccountManager authenticator — mandatory, not decorative
 * (ARCHITECTURE.md §6).
 *
 * AAOS surfaces accounts in the car's own Settings, and guest/secondary profiles
 * are governed by `DISALLOW_MODIFY_ACCOUNTS`: an app whose sign-in the system
 * cannot see is an app the system cannot let a passenger add or a fleet admin
 * forbid. So the car's sign-in gets an account row, and this class is what makes
 * "Add account -> TomeSonic" reach it.
 *
 * It is deliberately a STUB in the AOSP sense (the "stub authenticator" of the
 * sync-adapter guide): the only method with an implementation is [addAccount],
 * which hands the system an Intent for [SignInActivity]. Tokens live in the
 * DataStore and NOWHERE else (§6) — `getAuthToken` here would either lie or leak,
 * so it declines instead.
 *
 * The one deviation from that AOSP stub: where the guide's sample throws
 * `UnsupportedOperationException` from the methods it doesn't implement, the
 * methods here RETURN (an error bundle or null) instead. A throw here crosses a
 * Binder into the AccountManagerService's caller — usually the car's Settings
 * app — and "the car's account screen crashed" is not a better answer than
 * "not supported".
 */
class AbsAuthenticator(private val context: Context) : AbstractAccountAuthenticator(context) {

    /**
     * "Add account -> TomeSonic" from the car's Settings. The system starts the
     * returned Intent for us; a sign-in that cannot happen while driving is the
     * system's call to make (§5 — the activity carries no `distractionOptimized`
     * meta-data precisely so the platform can refuse it), not this method's.
     *
     * [response] rides along so the activity can answer the AccountManager call
     * that started it (see SignInActivity) — without it, the caller waits for a
     * result that never comes and reports a cancellation on a sign-in that
     * actually succeeded.
     */
    override fun addAccount(
        response: AccountAuthenticatorResponse?,
        accountType: String?,
        authTokenType: String?,
        requiredFeatures: Array<out String>?,
        options: Bundle?
    ): Bundle = Bundle().apply {
        putParcelable(
            AccountManager.KEY_INTENT,
            Intent(context, SignInActivity::class.java).apply {
                putExtra(AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE, response)
            }
        )
    }

    /** Nothing to edit: the account has no properties this app owns. */
    override fun editProperties(
        response: AccountAuthenticatorResponse?,
        accountType: String?
    ): Bundle? = null

    /**
     * There is no password in AccountManager to confirm — [ensure] adds the
     * account with a null one, because the credentials are the DataStore's.
     */
    override fun confirmCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        options: Bundle?
    ): Bundle? = null

    /**
     * Declined, by contract. The ABS access token is the DataStore's and is
     * never handed to AccountManager (§6): an auth token returned here would be
     * readable by anything holding this account's type and would age out
     * without AbsClient's single-flight refresh knowing.
     *
     * An error bundle rather than a null: null from `getAuthToken` reaches the
     * caller as an unexplained failure, and this failure has an explanation.
     */
    override fun getAuthToken(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?
    ): Bundle = Bundle().apply {
        putInt(AccountManager.KEY_ERROR_CODE, AccountManager.ERROR_CODE_UNSUPPORTED_OPERATION)
        putString(
            AccountManager.KEY_ERROR_MESSAGE,
            "TomeSonic keeps its server token in app storage, not in AccountManager."
        )
    }

    /** No token types, so no label for one. */
    override fun getAuthTokenLabel(authTokenType: String?): String? = null

    /**
     * Not a re-auth path. The car re-authenticates through the Media Center's
     * "Sign in" affordance, which opens [SignInActivity] directly (§6) — routing
     * this one there too would give the same screen two owners of the same
     * AccountManager response.
     */
    override fun updateCredentials(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        authTokenType: String?,
        options: Bundle?
    ): Bundle? = null

    /**
     * This account type declares no features. A `false` answer, not a null: the
     * caller reads KEY_BOOLEAN_RESULT out of this bundle unconditionally.
     */
    override fun hasFeatures(
        response: AccountAuthenticatorResponse?,
        account: Account?,
        features: Array<out String>?
    ): Bundle = Bundle().apply {
        putBoolean(AccountManager.KEY_BOOLEAN_RESULT, false)
    }

    companion object {

        /**
         * Frozen: this string is written in three places that must agree — here,
         * `res/xml/authenticator.xml`, and every AccountManager call below. It
         * is the applicationId rather than the namespace because an account type
         * is an app-wide identity, and this artifact shares its identity with
         * the phone build (ARCHITECTURE.md §1).
         */
        const val ACCOUNT_TYPE = "com.tomesonic.app"

        /**
         * What the account row is called. The username when the server gave one,
         * the server's host when it didn't — an account row labelled with a bare
         * token or an empty string is worse than one labelled with the address
         * the user typed.
         */
        fun accountName(username: String?, server: String?): String {
            val user = username?.trim().orEmpty()
            if (user.isNotEmpty()) return user
            val origin = server?.trim().orEmpty()
            if (origin.isEmpty()) return ""
            // Uri.parse never throws — a value it can't read simply has no host,
            // and the raw origin is a better label than nothing.
            return Uri.parse(origin).host?.takeIf { it.isNotBlank() } ?: origin
        }

        /**
         * Mirror the creds store into AccountManager: ONE account, named [name].
         *
         * No permission is involved. Since API 23 an app may list, add and remove
         * accounts of a type ITS OWN authenticator owns without `GET_ACCOUNTS`,
         * which is why that permission is absent from the manifest and must stay
         * absent — a car build asking for the accounts permission reads to a
         * reviewer exactly like one that wants the other accounts on the head
         * unit.
         *
         * Best effort by design: the credentials are already stored by the time
         * this runs, and a head unit that refuses the row must not turn a
         * successful sign-in into a failed one.
         */
        fun ensure(context: Context, name: String) {
            val display = name.trim()
            if (display.isEmpty()) return
            try {
                val manager = AccountManager.get(context)
                val existing = manager.getAccountsByType(ACCOUNT_TYPE)
                // One account max (§6). A rename is a remove plus an add: the
                // account NAME is its identity to AccountManager, so signing in
                // as someone else leaves the old row behind otherwise.
                existing.filter { it.name != display }.forEach { manager.removeAccountExplicitly(it) }
                if (existing.none { it.name == display }) {
                    // Null password, null userData: the tokens are the
                    // DataStore's and this row is a pointer, not a copy.
                    manager.addAccountExplicitly(Account(display, ACCOUNT_TYPE), null, null)
                }
            } catch (t: Throwable) {
                // Nothing to recover and nothing to log — the sign-in stands.
            }
        }

        /**
         * The mirror image, for sign-out: the account row goes when the
         * credentials do, or the car's Settings keeps offering an account this
         * app can no longer act as.
         */
        fun forget(context: Context) {
            try {
                val manager = AccountManager.get(context)
                manager.getAccountsByType(ACCOUNT_TYPE).forEach { manager.removeAccountExplicitly(it) }
            } catch (t: Throwable) {
                // Same trade as [ensure]: the credentials are already cleared.
            }
        }
    }
}
