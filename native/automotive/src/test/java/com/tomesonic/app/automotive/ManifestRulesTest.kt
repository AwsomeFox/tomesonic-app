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
 * Robolectric runtime and runs in milliseconds. Nothing merges into this module
 * today — it has no manifest-carrying dependencies — so the source manifest is
 * the artifact's manifest.
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
    }

    @Test
    fun noComponentIsMarkedDistractionOptimized() {
        // "Your app will be rejected during review if such an element is
        // present." Sign-in and settings are parked-only by policy.
        val offenders = names("meta-data").filter { it.contains("distractionOptimized") }
        assertTrue("distractionOptimized meta-data found: $offenders", offenders.isEmpty())
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

    private fun Element.androidName(): String? =
        getAttribute("android:name").takeIf { it.isNotEmpty() }

    private companion object {
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
