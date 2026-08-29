package com.tomesonic.app.automotive.account

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * The bound service AccountManager talks to. The whole class is the standard
 * AOSP shape and deliberately nothing more: the system binds it with the
 * `android.accounts.AccountAuthenticator` action (see the manifest) and reads
 * the account type out of the `@xml/authenticator` meta-data next to it.
 *
 * exported=true is REQUIRED here for the same reason it is on
 * AbsLibraryService: AccountManagerService binds in from OUTSIDE this app, and
 * an un-exported authenticator service is simply never called — the account
 * type then does not exist as far as the car's Settings is concerned.
 *
 * Lazy, because binding is the only thing that can happen to this service and
 * the authenticator's Binder should not be built by a process that only ever
 * started it.
 */
class AbsAuthenticatorService : Service() {

    private val authenticator: AbsAuthenticator by lazy { AbsAuthenticator(this) }

    override fun onBind(intent: Intent?): IBinder? = authenticator.iBinder
}
