package com.tomesonic.app.automotive.ui

import android.accounts.AccountAuthenticatorResponse
import android.accounts.AccountManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.IntentCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import com.tomesonic.app.automotive.Graph
import com.tomesonic.app.automotive.R
import com.tomesonic.app.automotive.account.AbsAuthenticator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The car's sign-in screen (ARCHITECTURE.md §6): server address, username,
 * password, full screen, ordinary touch keyboard.
 *
 * It is reached from exactly two places, and neither of them is a launcher icon
 * (there is none, §5): the Media Center's "Sign in" error affordance, and the
 * car's Settings via [AbsAuthenticator]'s `addAccount`. It is available only
 * while parked, and NOTHING here makes that true — the platform withholds an
 * activity that does not declare `distractionOptimized`, and declaring it is a
 * documented review rejection. The one rule this file follows for it is the
 * negative one: no code that tries to detect or override driving state.
 *
 * On success it persists the credentials, mirrors them into an AccountManager
 * row, and finishes. It does NOT tell the media service anything: that service
 * already collects [com.tomesonic.app.automotive.data.CredsRepository.creds] and
 * invalidates its browse tree when the identity changes, which is the same
 * mechanism a token refresh uses (§6).
 */
class SignInActivity : AppCompatActivity() {

    /**
     * Main-thread scope from the activity's own executor.
     *
     * `Dispatchers.Main` is NOT available in this module — it deliberately
     * depends on kotlinx-coroutines-core alone (see build.gradle), and
     * `mainExecutor.asCoroutineDispatcher()` is the same bridge
     * AbsLibraryService uses for media3's main-thread demands. Lazy because
     * `mainExecutor` needs an attached base context, which a field initialiser
     * runs too early to have.
     */
    private val uiScope: CoroutineScope by lazy {
        CoroutineScope(SupervisorJob() + mainExecutor.asCoroutineDispatcher())
    }

    private lateinit var viewModel: SignInViewModel

    private lateinit var serverField: EditText
    private lateinit var usernameField: EditText
    private lateinit var passwordField: EditText
    private lateinit var demoLink: TextView
    private lateinit var errorLine: TextView
    private lateinit var progress: ProgressBar
    private lateinit var submit: Button

    /**
     * Set when this activity was started BY AccountManager (`addAccount`). The
     * caller blocks on it: answering is not optional, and the two answers are
     * "here is the account" and "the user backed out". Held and cleared exactly
     * as the platform's deprecated AccountAuthenticatorActivity did it.
     */
    private var authenticatorResponse: AccountAuthenticatorResponse? = null
    private var authenticatorResult: Bundle? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Idempotent, and defensive in the sense Graph's own doc describes: the
        // system can start this activity directly (Settings -> Add account), and
        // although Application.onCreate always precedes it, the graph resolving
        // is not something this screen should have to assume.
        Graph.init(applicationContext)

        authenticatorResponse = IntentCompat.getParcelableExtra(
            intent,
            AccountManager.KEY_ACCOUNT_AUTHENTICATOR_RESPONSE,
            AccountAuthenticatorResponse::class.java
        )
        authenticatorResponse?.onRequestContinued()

        // Edge-to-edge on EVERY api level this module runs on, not just on 35
        // where targetSdk forces it. One layout model means one insets path:
        // the window is never resized for the system bars or for the keyboard,
        // and the listener below is the only thing that moves the form. The
        // alternative — letting the platform resize on 28-34 and reporting IME
        // insets to us as well on 30+ — pads the same keyboard twice.
        WindowCompat.setDecorFitsSystemWindows(window, false)

        setContentView(R.layout.activity_sign_in)

        serverField = findViewById(R.id.sign_in_server)
        usernameField = findViewById(R.id.sign_in_username)
        passwordField = findViewById(R.id.sign_in_password)
        demoLink = findViewById(R.id.sign_in_demo)
        errorLine = findViewById(R.id.sign_in_error)
        progress = findViewById(R.id.sign_in_progress)
        submit = findViewById(R.id.sign_in_submit)

        // AR-1: keep the form clear of the car's system bars and of any display
        // cutout, and clear of the on-screen keyboard while it is up. SDK 35
        // lays the window out edge-to-edge with no decor fitting, so this
        // listener is the only thing standing between the submit button and the
        // navigation bar.
        val root = findViewById<View>(R.id.sign_in_root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or
                    WindowInsetsCompat.Type.displayCutout() or
                    WindowInsetsCompat.Type.ime()
            )
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        viewModel = SignInViewModel(
            scope = uiScope,
            backend = AbsSignInBackend(Graph.absApi, Graph.credsRepository)
        )

        submit.setOnClickListener { attempt() }
        // The keyboard covers the button on a short head unit; Done is the key
        // under the user's thumb when the last field is filled.
        passwordField.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                attempt()
                true
            } else {
                false
            }
        }
        // The reviewer affordance (§12 risk 1). It fills the field rather than
        // signing in: the username and password still come from the review notes.
        demoLink.setOnClickListener {
            serverField.setText(SignInViewModel.DEMO_SERVER)
            serverField.setSelection(serverField.text.length)
            usernameField.requestFocus()
        }

        uiScope.launch { viewModel.state.collect { render(it) } }
    }

    override fun onDestroy() {
        uiScope.cancel()
        super.onDestroy()
    }

    /**
     * The AccountManager caller is answered HERE and only here, so that a back
     * press, a system finish and a successful sign-in all resolve it — the
     * platform's own AccountAuthenticatorActivity used exactly this override,
     * for exactly that reason.
     */
    override fun finish() {
        authenticatorResponse?.let { response ->
            val result = authenticatorResult
            if (result != null) {
                response.onResult(result)
            } else {
                response.onError(AccountManager.ERROR_CODE_CANCELED, "canceled")
            }
            authenticatorResponse = null
        }
        super.finish()
    }

    private fun attempt() {
        // The password is read here, handed to one request, and never held: it
        // is not a field on this class and not part of any state.
        viewModel.signIn(serverField.text, usernameField.text, passwordField.text)
    }

    private fun render(state: SignInState) {
        val working = state is SignInState.Working
        serverField.isEnabled = !working
        usernameField.isEnabled = !working
        passwordField.isEnabled = !working
        demoLink.isEnabled = !working
        submit.isEnabled = !working
        progress.visibility = if (working) View.VISIBLE else View.GONE

        val message = (state as? SignInState.Error)?.message
        errorLine.text = message.orEmpty()
        errorLine.visibility = if (message == null) View.GONE else View.VISIBLE

        if (state is SignInState.Done) onSignedIn()
    }

    /**
     * Terminal. The credentials are already in the store by the time this runs
     * (the view model writes them before it reports Done); what is left is the
     * AccountManager mirror and getting off the screen.
     */
    private fun onSignedIn() {
        uiScope.launch {
            // Read the identity back from the STORE rather than from the fields:
            // the store is what the account row mirrors, and it holds the
            // normalised origin and the server's own spelling of the username.
            val creds = try {
                Graph.credsRepository.creds.first()
            } catch (t: Throwable) {
                null
            }
            if (creds != null) {
                val name = AbsAuthenticator.accountName(creds.username, creds.server)
                // AccountManager's calls are synchronous binder IPC — off the
                // UI thread, or a slow AccountManagerService spends sign-in's
                // last frames blocked inside a system service (Copilot round).
                withContext(Dispatchers.IO) {
                    AbsAuthenticator.ensure(this@SignInActivity, name)
                }
                authenticatorResult = Bundle().apply {
                    putString(AccountManager.KEY_ACCOUNT_NAME, name)
                    putString(AccountManager.KEY_ACCOUNT_TYPE, AbsAuthenticator.ACCOUNT_TYPE)
                }
            }
            finish()
        }
    }

    companion object {

        /**
         * This screen as an Intent — the seam for §6's Media Center affordance.
         *
         * The PendingIntent and the media3 session-error extras that carry it
         * ("Sign in" / ERROR_RESOLUTION_ACTION_*) belong to AbsLibraryService,
         * whose exact media3 1.8 spelling is the emulator spike's to pin; this
         * is only the target it will point at, kept here so the flags live with
         * the activity rather than with the service that names it.
         *
         * NEW_TASK because the caller is the media session — a service, and on
         * the car's Media Center's stack rather than on ours.
         */
        fun intent(context: Context): Intent =
            Intent(context, SignInActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
}
