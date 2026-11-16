package com.drivepass.android

import android.app.Application
import android.content.Context
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * An edit interrupted by auto-lock comes back with the next unlock — sealed in
 * between, never readable.
 *
 * Drives the real VaultViewModel through open, unlock, edit, lock and unlock
 * again, because the bug this guards against lives in the wiring: stashing
 * after the key is zeroed instead of before, or restoring into a vault that
 * cannot be saved, would both pass a test of the crypto alone.
 */
@RunWith(AndroidJUnit4::class)
class EditSurvivesLockTest {

    private val password = "correct-horse-battery-staple"
    private val app get() =
        InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as Application
    private val scratch get() = File(app.cacheDir, "edit-lock-test").apply { mkdirs() }

    private fun prefs() = app.getSharedPreferences("drivepass", Context.MODE_PRIVATE)

    // These tests run inside the real app's process. Opening a scratch vault
    // records it as the recent vault, which would otherwise overwrite the
    // user's own — so the whole preferences file is put back afterwards.
    private lateinit var savedPrefs: Map<String, *>

    @Before
    fun snapshotPrefs() {
        savedPrefs = HashMap(prefs().all)
    }

    @After
    fun restorePrefs() {
        val e = prefs().edit().clear()
        for ((k, v) in savedPrefs) {
            when (v) {
                is String -> e.putString(k, v)
                is Int -> e.putInt(k, v)
                is Long -> e.putLong(k, v)
                is Boolean -> e.putBoolean(k, v)
                is Float -> e.putFloat(k, v)
                is Set<*> -> e.putStringSet(k, v.filterIsInstance<String>().toSet())
            }
        }
        e.commit()
        scratch.deleteRecursively()
    }

    private fun fixture() = app.assets.open("fixture-vault.enc").bufferedReader().use { it.readText() }

    private fun await(vm: VaultViewModel, what: (UiState) -> Boolean): UiState =
        runBlocking { withTimeout(30_000) { vm.state.first(what) } }

    private fun unlocked(vm: VaultViewModel) = await(vm) { it is UiState.Unlocked } as UiState.Unlocked

    /** A writable picked vault, unlocked. */
    private fun openFixture(): Pair<VaultViewModel, Uri> {
        val uri = Uri.fromFile(File(scratch, "vault.enc").apply { writeText(fixture()) })
        val vm = VaultViewModel(app)
        vm.openPicked(uri)
        await(vm) { it is UiState.Unlock }
        vm.unlock(password.toCharArray())
        assertTrue("a picked local file must be writable", unlocked(vm).writable)
        return vm to uri
    }

    private fun relock(vm: VaultViewModel): UiState.Unlocked {
        vm.lock()
        assertTrue(vm.state.value is UiState.Unlock)
        vm.unlock(password.toCharArray())
        return unlocked(vm)
    }

    @Test
    fun aDirtyEditComesBackAfterLockAndUnlock() {
        val (vm, _) = openFixture()
        val initial = EntryDraft.of(unlocked(vm).entries.first { it.id == "fixture-01" })
        val current = initial.copy(password = "half-typed-new-pass")
        vm.editing(initial, current)

        assertEquals(EditSession(initial, current), relock(vm).restoredEdit)
    }

    @Test
    fun aNewUnsavedEntryComesBackToo() {
        val (vm, _) = openFixture()
        val current = EntryDraft(name = "Bank", username = "me", password = "secret")
        vm.editing(EntryDraft(), current)

        val restored = relock(vm).restoredEdit ?: return fail("the draft was lost")
        assertEquals(current, restored.current)
        assertNull("still a new entry", restored.initial.id)
    }

    @Test
    fun anUntouchedEditorIsNotRestored() {
        val (vm, _) = openFixture()
        val initial = EntryDraft.of(unlocked(vm).entries.first())
        vm.editing(initial, initial)

        assertNull("nothing to recover", relock(vm).restoredEdit)
    }

    @Test
    fun aFinishedEditIsNotRestored() {
        val (vm, _) = openFixture()
        val initial = EntryDraft.of(unlocked(vm).entries.first())
        vm.editing(initial, initial.copy(name = "changed"))
        vm.editingDone()

        assertNull(relock(vm).restoredEdit)
    }

    @Test
    fun closingTheVaultDiscardsTheStash() {
        // Backing out of the unlock screen is a choice to leave; the edit goes.
        val (vm, uri) = openFixture()
        val initial = EntryDraft.of(unlocked(vm).entries.first())
        vm.editing(initial, initial.copy(name = "changed"))
        vm.lock()
        vm.closeVault()

        vm.openPicked(uri)
        await(vm) { it is UiState.Unlock }
        vm.unlock(password.toCharArray())
        assertNull(unlocked(vm).restoredEdit)
    }

    @Test
    fun theStashOnlyOpensUnderTheSameKey() {
        // The sealing itself: the same vault key opens it, any other does not.
        val env = VaultCrypto.parseEnvelope(fixture())
        val key = VaultCrypto.deriveKey(password.toCharArray(), env.salt, env.iterations)
        val session = EditSession(EntryDraft(name = "A"), EntryDraft(name = "A", password = "p"))
        val sealed = VaultCrypto.seal(key, session.toJson(), env)

        assertEquals(session, EditSession.fromJson(VaultCrypto.decrypt(key, sealed)))
        val other = VaultCrypto.deriveKey("a-different-password".toCharArray(), env.salt, env.iterations)
        try {
            VaultCrypto.decrypt(other, sealed)
            fail("a different key must not open the stash")
        } catch (e: VaultError.WrongPassword) {
            // expected
        }
    }

    @Test
    fun editSessionJsonKeepsEveryField() {
        val full = EntryDraft(
            id = "x", type = "card", name = "N", url = "u", username = "us", password = "pw",
            totp = "t", notes = "no\ntes", favorite = true, cardNumber = "4111",
            cardHolder = "H", cardExpMonth = "09", cardExpYear = "28", cardCvv = "123",
        )
        val session = EditSession(EntryDraft(), full)
        assertEquals(session, EditSession.fromJson(session.toJson()))
    }
}
