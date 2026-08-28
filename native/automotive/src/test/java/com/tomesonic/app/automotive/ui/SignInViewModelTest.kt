package com.tomesonic.app.automotive.ui

import com.tomesonic.app.automotive.data.LoginResult
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The sign-in state machine, and the sentences it puts on the screen.
 *
 * The donor (`:wear`'s ConnectViewModel) ships no test of its own — only
 * WatchLoginTest, which covers the address rule and the copy. That half is
 * ported below row for row; the rest of this file is the table that donor never
 * wrote down: which failure becomes which state, what a second tap does while
 * the first is in flight, and what happens when the login succeeds but the
 * store refuses the write.
 *
 * Plain JUnit, no Robolectric: nothing here touches android.jar. The same is
 * true of WatchLoginTest, which is the evidence that
 * `CredsRepository.normalizeServer` (a companion function on a class whose
 * fields are DataStore keys) loads on a bare JVM.
 *
 * [Dispatchers.Unconfined] rather than a coroutine-test dependency (this module
 * deliberately has none, exactly as `:wear` doesn't): a fake backend that does
 * not suspend runs the whole launch body inline, so `signIn` returns with the
 * terminal state already set. The one test that needs to observe the state
 * BETWEEN the two hands a gate to the backend instead.
 */
class SignInViewModelTest {

    // ---- fixtures ------------------------------------------------------------

    private class FakeBackend : SignInBackend {
        val loginCalls = mutableListOf<Triple<String, String, String>>()
        val stored = mutableListOf<LoginResult.Success>()
        var loginAnswer: LoginResult = LoginResult.Unreachable
        var loginThrows: Throwable? = null
        var storeThrows: Throwable? = null

        override suspend fun login(server: String, username: String, password: String): LoginResult {
            loginCalls += Triple(server, username, password)
            loginThrows?.let { throw it }
            return loginAnswer
        }

        override suspend fun store(result: LoginResult.Success) {
            storeThrows?.let { throw it }
            stored += result
        }
    }

    /** A backend whose login is held open until the test lets it answer. */
    private class GatedBackend : SignInBackend {
        val gate = CompletableDeferred<LoginResult>()
        var loginCalls = 0
        val stored = mutableListOf<LoginResult.Success>()

        override suspend fun login(server: String, username: String, password: String): LoginResult {
            loginCalls++
            return gate.await()
        }

        override suspend fun store(result: LoginResult.Success) {
            stored += result
        }
    }

    private val scope = CoroutineScope(Dispatchers.Unconfined)

    private fun success(server: String = "https://abs.example.com") = LoginResult.Success(
        server = server,
        token = "acc",
        refreshToken = "ref",
        userId = "u1",
        username = "tony"
    )

    private fun errorOf(state: SignInState): String {
        assertTrue("expected an Error state, got $state", state is SignInState.Error)
        return (state as SignInState.Error).message
    }

    // ---- the happy path ------------------------------------------------------

    @Test
    fun `a good login stores the result and ends done`() {
        val backend = FakeBackend()
        val answer = success()
        backend.loginAnswer = answer
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertSame(SignInState.Done, vm.state.value)
        assertEquals(1, backend.stored.size)
        // The SAME object the server's answer produced — the store is handed the
        // server's own spelling of the identity, not the typed one.
        assertSame(answer, backend.stored.single())
    }

    @Test
    fun `the server is normalised before it reaches the network`() {
        val backend = FakeBackend()
        backend.loginAnswer = success()
        val vm = SignInViewModel(scope, backend)

        // Scheme-less and slash-suffixed, which is what a typed address is.
        vm.signIn("  abs.example.com/  ", "  tony  ", "hunter2")

        assertEquals(
            Triple("https://abs.example.com", "tony", "hunter2"),
            backend.loginCalls.single()
        )
    }

    @Test
    fun `the password is passed through untrimmed`() {
        // Whitespace is a legal password character; trimming it would turn a
        // correct password into "Invalid username or password."
        val backend = FakeBackend()
        backend.loginAnswer = success()
        SignInViewModel(scope, backend).signIn("abs.example.com", "tony", "  hunter2  ")

        assertEquals("  hunter2  ", backend.loginCalls.single().third)
    }

    // ---- the four server answers ---------------------------------------------

    @Test
    fun `wrong credentials read as the phone's line`() {
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.BadCredentials
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "wrong")

        assertEquals(SignInViewModel.INVALID_CREDENTIALS, errorOf(vm.state.value))
        assertTrue(backend.stored.isEmpty())
    }

    @Test
    fun `an unreachable server reads as the phone's line`() {
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.Unreachable
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertEquals(SignInViewModel.UNREACHABLE, errorOf(vm.state.value))
    }

    @Test
    fun `a rate-limited server reads as the phone's line`() {
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.RateLimited
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertEquals(SignInViewModel.RATE_LIMITED, errorOf(vm.state.value))
    }

    @Test
    fun `a broken server reads as the phone's line`() {
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.ServerError
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertEquals(SignInViewModel.SERVER_PROBLEM, errorOf(vm.state.value))
    }

    // ---- the failures that aren't the server's -------------------------------

    @Test
    fun `a blank field never reaches the network`() {
        val backend = FakeBackend()
        backend.loginAnswer = success()

        for (attempt in listOf(
            Triple("", "tony", "hunter2"),
            Triple("   ", "tony", "hunter2"),
            Triple("abs.example.com", "", "hunter2"),
            Triple("abs.example.com", "   ", "hunter2"),
            Triple("abs.example.com", "tony", "")
        )) {
            val vm = SignInViewModel(scope, backend)
            vm.signIn(attempt.first, attempt.second, attempt.third)
            assertEquals(SignInViewModel.INCOMPLETE, errorOf(vm.state.value))
        }
        assertTrue("nothing should have been sent: ${backend.loginCalls}", backend.loginCalls.isEmpty())
    }

    @Test
    fun `a bad address is a server the car couldn't reach`() {
        // There is NO client-side URL validation, deliberately: a self-hosted
        // ABS lives at a bare IP, a LAN name, a port, a reverse-proxied
        // sub-path — and a rule that decided which of those looked "valid"
        // would reject a working server sooner or later. So a nonsense address
        // travels as far as the socket and comes back as the sentence that
        // points at both things it could be: the address and the connection.
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.Unreachable
        val vm = SignInViewModel(scope, backend)

        vm.signIn("not a server", "tony", "hunter2")

        assertEquals(SignInViewModel.UNREACHABLE, errorOf(vm.state.value))
        assertEquals("https://not a server", backend.loginCalls.single().first)
    }

    @Test
    fun `a backend that throws is treated as unreachable`() {
        // AbsApi.login does not throw; an uninitialised Graph could. Either way
        // the car is not signed in, and the app must not die on the form.
        val backend = FakeBackend()
        backend.loginThrows = IllegalStateException("Graph.init(context) must run first")
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertEquals(SignInViewModel.UNREACHABLE, errorOf(vm.state.value))
    }

    @Test
    fun `a login that cannot be stored says so instead of claiming success`() {
        val backend = FakeBackend()
        backend.loginAnswer = success()
        backend.storeThrows = java.io.IOException("read-only filesystem")
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")

        assertEquals(SignInViewModel.NOT_SAVED, errorOf(vm.state.value))
    }

    // ---- the state machine ---------------------------------------------------

    @Test
    fun `it starts idle`() {
        assertSame(SignInState.Idle, SignInViewModel(scope, FakeBackend()).state.value)
    }

    @Test
    fun `a second tap while working opens no second socket`() {
        val backend = GatedBackend()
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")
        assertSame(SignInState.Working, vm.state.value)

        vm.signIn("abs.example.com", "tony", "hunter2")
        assertEquals(1, backend.loginCalls)
        assertSame(SignInState.Working, vm.state.value)

        backend.gate.complete(success())
        assertSame(SignInState.Done, vm.state.value)
    }

    @Test
    fun `done is terminal`() {
        // The activity is already finishing on Done; a late tap must not start
        // a login into a screen that is going away.
        val backend = FakeBackend()
        backend.loginAnswer = success()
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "hunter2")
        vm.signIn("abs.example.com", "tony", "hunter2")

        assertSame(SignInState.Done, vm.state.value)
        assertEquals(1, backend.loginCalls.size)
    }

    @Test
    fun `an error is retryable`() {
        val backend = FakeBackend()
        backend.loginAnswer = LoginResult.BadCredentials
        val vm = SignInViewModel(scope, backend)

        vm.signIn("abs.example.com", "tony", "wrong")
        assertEquals(SignInViewModel.INVALID_CREDENTIALS, errorOf(vm.state.value))

        backend.loginAnswer = success()
        vm.signIn("abs.example.com", "tony", "hunter2")

        assertSame(SignInState.Done, vm.state.value)
        assertEquals(2, backend.loginCalls.size)
    }

    // ---- the address rule (ported from :wear's WatchLoginTest) ---------------

    @Test
    fun `a scheme-less address gets https`() {
        // The safe scheme, not the convenient one. A self-hosted server on
        // plain http stays reachable by typing it — which is why the manifest
        // keeps cleartext traffic on.
        assertEquals(
            "https://abs.example.com",
            SignInViewModel.normalizeEntry("abs.example.com")
        )
        assertEquals(
            "https://abs.local:13378",
            SignInViewModel.normalizeEntry("abs.local:13378")
        )
    }

    @Test
    fun `a typed scheme is kept, http included`() {
        assertEquals("http://abs.local", SignInViewModel.normalizeEntry("http://abs.local"))
        assertEquals("https://abs.local", SignInViewModel.normalizeEntry("https://abs.local"))
        assertEquals(
            "http://10.0.0.5:8080",
            SignInViewModel.normalizeEntry("  http://10.0.0.5:8080  ")
        )
    }

    @Test
    fun `trailing slashes are stripped, all of them`() {
        // Every URL in the app concatenates a leading-slash path onto this.
        assertEquals("https://abs.local", SignInViewModel.normalizeEntry("abs.local/"))
        assertEquals("http://abs.local", SignInViewModel.normalizeEntry("http://abs.local///"))
    }

    @Test
    fun `nothing typed is nothing to try`() {
        assertNull(SignInViewModel.normalizeEntry(null))
        assertNull(SignInViewModel.normalizeEntry(""))
        assertNull(SignInViewModel.normalizeEntry("   "))
    }

    // ---- the copy ------------------------------------------------------------

    @Test
    fun `each failure maps to the phone's own wording`() {
        assertEquals(
            SignInViewModel.INVALID_CREDENTIALS,
            SignInViewModel.message(LoginResult.BadCredentials)
        )
        assertEquals(SignInViewModel.UNREACHABLE, SignInViewModel.message(LoginResult.Unreachable))
        assertEquals(SignInViewModel.RATE_LIMITED, SignInViewModel.message(LoginResult.RateLimited))
        assertEquals(SignInViewModel.SERVER_PROBLEM, SignInViewModel.message(LoginResult.ServerError))
    }

    @Test
    fun `the wording is the phone's, verbatim`() {
        // screens/ConnectScreen.tsx, by way of :wear's WatchLogin — a user who
        // mistypes in the car and again on the phone must be told the same
        // thing by both. These four literals are the contract.
        assertEquals("Invalid username or password.", SignInViewModel.INVALID_CREDENTIALS)
        assertEquals(
            "Couldn't reach the server. Check the address and your connection.",
            SignInViewModel.UNREACHABLE
        )
        assertEquals(
            "Too many attempts. Please wait a moment and try again.",
            SignInViewModel.RATE_LIMITED
        )
        assertEquals("The server had a problem. Please try again.", SignInViewModel.SERVER_PROBLEM)
        assertEquals(
            "Enter the server address, username and password.",
            SignInViewModel.INCOMPLETE
        )
        // The one line that is NOT the donor's verbatim: its version names the
        // watch, and the device noun is the whole content of the sentence.
        assertEquals(
            "Signed in, but this car couldn't save it. Try again.",
            SignInViewModel.NOT_SAVED
        )
    }

    @Test
    fun `a success has no line - the activity finishes`() {
        assertNull(SignInViewModel.message(success()))
    }

    // ---- the reviewer affordance --------------------------------------------

    @Test
    fun `the demo server prefill is a well-formed origin`() {
        // A PLACEHOLDER, pinned deliberately: which instance serves the Play
        // review window is the Wave 5 runbook's decision (ARCHITECTURE.md §12
        // risk 1), and when it lands this row changes with the constant rather
        // than the value slipping in unnoticed.
        assertEquals("https://demo.tomesonic.example", SignInViewModel.DEMO_SERVER)
        // Whatever it becomes, it has to survive the same normalisation the
        // typed field gets — an origin with no trailing slash and a scheme.
        assertEquals(
            SignInViewModel.DEMO_SERVER,
            SignInViewModel.normalizeEntry(SignInViewModel.DEMO_SERVER)
        )
    }
}
