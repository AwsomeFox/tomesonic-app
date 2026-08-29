package com.tomesonic.app.automotive

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The car-review rules that live in the manifest (ARCHITECTURE.md §5 and §10).
 *
 * Every assertion here is a documented Play rejection or a platform rule, and
 * every one of them is a single careless line away from coming back: a copied
 * `<activity>` block brings its LAUNCHER intent-filter along, and
 * `distractionOptimized` is exactly the meta-data someone reaches for when a
 * car screen "doesn't show while driving". The car artifact is only ever
 * reviewed on a dedicated Play track, so this JVM test is the fast feedback
 * loop for all of it.
 *
 * Plain JUnit on purpose: it reads the SOURCE manifest off disk, so it needs no
 * Robolectric runtime and runs in milliseconds. Library manifests do merge on
 * top of it (androidx.work's foreground service; appcompat and preference,
 * which declare no components of their own), but every rule below is about what
 * THIS artifact declares — the launcher activity we must not have, the
 * meta-data we must not carry, the components each wave must land next to its
 * classes — and that is decided here, in the file under review.
 */
class ManifestRulesTest {

    private val manifestFile: File = locateManifest()
    private val manifestText: String = manifestFile.readText()

    // Namespace-unaware on purpose: attributes then read back under their
    // literal qualified names ("android:name"), which is how they are written
    // in the file and how a reviewer greps for them.
    private val document = DocumentBuilderFactory.newInstance()
        .newDocumentBuilder()
        .parse(manifestFile)

    @Test
    fun thereIsNoLauncherActivity() {
        // AAOS shows no launcher icon for a media app — the system opens it by
        // explicit intent from the Media Center. An ACTION_MAIN activity is
        // also the thing the screenshot rig would wrongly reach for (§11).
        assertFalse(
            "android.intent.action.MAIN must not appear in ${manifestFile.name}",
            names("action").contains("android.intent.action.MAIN")
        )
        assertFalse(
            "android.intent.category.LAUNCHER must not appear in ${manifestFile.name}",
            names("category").contains("android.intent.category.LAUNCHER")
        )
        // Named, not just counted. The global assertions above go green on a
        // manifest that has lost an activity entirely; these two are the ones
        // a copied <activity> block would break, so they are asserted ON those
        // two activities by name.
        for (name in PARKED_ACTIVITIES) {
            val activity = requireComponent("activity", name)
            assertFalse(
                "$name must not carry an ACTION_MAIN intent-filter",
                activity.descendantNames("action").contains("android.intent.action.MAIN")
            )
            assertFalse(
                "$name must not carry a CATEGORY_LAUNCHER intent-filter",
                activity.descendantNames("category").contains("android.intent.category.LAUNCHER")
            )
        }
    }

    @Test
    fun noComponentIsMarkedDistractionOptimized() {
        // "Your app will be rejected during review if such an element is
        // present." Sign-in and settings are parked-only by policy.
        val offenders = names("meta-data").filter { it.contains("distractionOptimized") }
        assertTrue("distractionOptimized meta-data found: $offenders", offenders.isEmpty())
        // And again per activity: this meta-data is exactly what someone
        // reaches for when a car screen "doesn't show while driving", and it is
        // these two activities they would reach for it on.
        for (name in PARKED_ACTIVITIES) {
            val found = requireComponent("activity", name)
                .descendantNames("meta-data")
                .filter { it.contains("distractionOptimized") }
            assertTrue("$name is marked distractionOptimized: $found", found.isEmpty())
        }
    }

    @Test
    fun theTwoParkedActivitiesAreDeclaredAndExported() {
        // Both are started from OUTSIDE this app — the Media Center's sign-in
        // affordance, the car's Settings, AccountManager's account picker — so
        // exported=true is functional, not incidental. They are also the only
        // two activities the artifact is allowed to have (§1, PE-1): no
        // functionality outside setup/sign-in/settings while parked, satisfied
        // by construction.
        assertEquals(
            "the shipped artifact declares exactly the sign-in and settings activities — " +
                "a dev-only screen (the Wave 6 screenshot rig's, say) belongs in " +
                "src/debug/AndroidManifest.xml, which never reaches a review build",
            PARKED_ACTIVITIES.toSet(),
            names("activity").toSet()
        )
        for (name in PARKED_ACTIVITIES) {
            assertEquals(
                "$name must be exported",
                "true",
                requireComponent("activity", name).getAttribute("android:exported")
            )
        }
    }

    @Test
    fun theSettingsActivityIsTheApplicationPreferencesTarget() {
        // What puts "TomeSonic settings" in the car's own Settings app. The
        // label is part of it: the head unit renders that string, not the
        // activity's class name.
        val settings = requireComponent("activity", SETTINGS_ACTIVITY)
        assertTrue(
            "$SETTINGS_ACTIVITY must answer ACTION_APPLICATION_PREFERENCES",
            settings.descendantNames("action")
                .contains("android.intent.action.APPLICATION_PREFERENCES")
        )
        assertEquals(
            "@string/app_settings_activity_title",
            settings.getAttribute("android:label")
        )
    }

    @Test
    fun theAccountAuthenticatorServiceIsDeclaredWithItsDescriptor() {
        // AccountManager is mandatory on AAOS (§6). The service is bound by
        // AccountManagerService from outside this app — un-exported, it is
        // simply never called and the account type does not exist — and the
        // account type itself is read from the meta-data resource, not from the
        // Kotlin, so a missing meta-data is a silently account-less build.
        val service = requireComponent("service", AUTHENTICATOR_SERVICE)
        assertEquals("$AUTHENTICATOR_SERVICE must be exported", "true", service.getAttribute("android:exported"))
        assertTrue(
            "$AUTHENTICATOR_SERVICE must answer android.accounts.AccountAuthenticator",
            service.descendantNames("action").contains("android.accounts.AccountAuthenticator")
        )
        val descriptor = service.descendants("meta-data")
            .firstOrNull { it.androidName() == "android.accounts.AccountAuthenticator" }
        assertNotNull("$AUTHENTICATOR_SERVICE is missing its authenticator meta-data", descriptor)
        assertEquals("@xml/authenticator", descriptor!!.getAttribute("android:resource"))
    }

    @Test
    fun theAutomotiveDescriptorIsDeclared() {
        val descriptor = elements("meta-data")
            .firstOrNull { it.androidName() == "com.android.automotive" }
        assertNotNull("com.android.automotive meta-data is missing", descriptor)
        assertEquals("@xml/automotive_app_desc", descriptor!!.getAttribute("android:resource"))
    }

    @Test
    fun theAndroidAutoDescriptorIsAbsent() {
        // Android Auto's descriptor belongs to the phone artifact. Grepping the
        // raw text rather than the parsed meta-data is deliberate: it also
        // catches the name arriving inside a comment or an unrelated attribute.
        assertFalse(
            "the Android Auto car-application descriptor must not appear in ${manifestFile.path}",
            manifestText.contains("com.google.android.gms.car.application")
        )
    }

    @Test
    fun theAutomotiveHardwareFeatureIsRequired() {
        // This is what makes Play serve the artifact to AAOS devices only.
        val feature = elements("uses-feature")
            .firstOrNull { it.androidName() == "android.hardware.type.automotive" }
        assertNotNull("uses-feature android.hardware.type.automotive is missing", feature)
        assertEquals("true", feature!!.getAttribute("android:required"))
    }

    // --- helpers ---

    private fun elements(tag: String): List<Element> {
        val nodes = document.getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun names(tag: String): List<String> = elements(tag).mapNotNull { it.androidName() }

    /** The named component, or a failure that says which one is missing. */
    private fun requireComponent(tag: String, name: String): Element {
        val found = elements(tag).firstOrNull { it.androidName() == name }
        assertNotNull("<$tag> $name is missing from ${manifestFile.name}", found)
        return found!!
    }

    private fun Element.descendants(tag: String): List<Element> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun Element.descendantNames(tag: String): List<String> =
        descendants(tag).mapNotNull { it.androidName() }

    private fun Element.androidName(): String? =
        getAttribute("android:name").takeIf { it.isNotEmpty() }

    private companion object {

        // Fully qualified, matching the manifest's stated convention: the
        // applicationId (com.tomesonic.app) differs from the namespace, so a
        // leading-dot name is the one thing that reads wrong there.
        const val SIGN_IN_ACTIVITY = "com.tomesonic.app.automotive.ui.SignInActivity"
        const val SETTINGS_ACTIVITY = "com.tomesonic.app.automotive.ui.SettingsActivity"
        const val AUTHENTICATOR_SERVICE =
            "com.tomesonic.app.automotive.account.AbsAuthenticatorService"

        /** The whole of this artifact's activity surface (§5, PE-1). */
        val PARKED_ACTIVITIES = listOf(SIGN_IN_ACTIVITY, SETTINGS_ACTIVITY)

        /**
         * Gradle runs unit tests with the module directory as the working
         * directory, but that is a default rather than a contract — and the
         * same file is worth finding from a repo-root or native/ invocation
         * too. Walk up from user.dir probing automotive-specific paths ONLY: a
         * bare `src/main/AndroidManifest.xml` probe would happily match the
         * phone module's manifest from the wrong ancestor.
         */
        fun locateManifest(): File {
            var dir = File(System.getProperty("user.dir")).absoluteFile
            while (true) {
                val candidates = mutableListOf<File>()
                if (dir.name == "automotive") {
                    candidates += File(dir, "src/main/AndroidManifest.xml")
                }
                candidates += File(dir, "automotive/src/main/AndroidManifest.xml")
                candidates += File(dir, "native/automotive/src/main/AndroidManifest.xml")
                candidates.firstOrNull { it.isFile }?.let { return it }
                dir = dir.parentFile ?: break
            }
            throw AssertionError(
                "automotive AndroidManifest.xml not found walking up from " +
                    System.getProperty("user.dir")
            )
        }
    }
}
