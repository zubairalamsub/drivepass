package com.drivepass.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * The decrypted payload's entry model, matching newEntry() in src/lib/vault.js
 * field for field. Unknown fields are preserved verbatim in [raw] so a
 * round-trip through this client never drops data a newer desktop release added.
 */
data class Entry(
    val id: String,
    val type: String,
    val name: String,
    val url: String,
    val username: String,
    val password: String,
    val totp: String,
    val notes: String,
    val favorite: Boolean,
    val createdAt: Long,
    val updatedAt: Long,
    val deletedAt: Long?,
    val cardNumber: String,
    val passkeyUserName: String,
    val raw: JSONObject,
) {
    val isDeleted get() = deletedAt != null

    /** The secondary line the desktop UI shows for this entry. */
    fun subtitle(): String = when (type) {
        "card" -> if (cardNumber.isNotEmpty()) "•••• " + cardNumber.takeLast(4) else "Credit Card"
        "note" -> "Secure Note"
        "passkey" -> passkeyUserName.ifEmpty { "Passkey" }
        else -> username.ifEmpty { url }
    }
}

data class VaultData(val entries: List<Entry>, val purged: List<String>)

object VaultModel {

    fun parse(plaintextJson: String): VaultData {
        val root = JSONObject(plaintextJson)
        val arr = root.optJSONArray("entries") ?: JSONArray()
        val entries = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let { fromJson(it) }
        }
        val purgedArr = root.optJSONArray("purged") ?: JSONArray()
        val purged = (0 until purgedArr.length()).map { purgedArr.getString(it) }
        return VaultData(entries, purged)
    }

    private fun fromJson(o: JSONObject): Entry {
        val card = o.optJSONObject("card")
        val passkey = o.optJSONObject("passkey")
        // deletedAt is `null` for live entries — JSONObject.isNull distinguishes
        // an explicit JSON null from an absent key, and both mean "live".
        val deleted = if (o.isNull("deletedAt")) null else o.optLong("deletedAt").takeIf { it != 0L }
        return Entry(
            id = o.optString("id"),
            type = o.optString("type", "login").ifEmpty { "login" },
            name = o.optString("name"),
            url = o.optString("url"),
            username = o.optString("username"),
            password = o.optString("password"),
            totp = o.optString("totp"),
            notes = o.optString("notes"),
            favorite = o.optBoolean("favorite", false),
            createdAt = o.optLong("createdAt"),
            updatedAt = o.optLong("updatedAt"),
            deletedAt = deleted,
            cardNumber = card?.optString("number") ?: "",
            passkeyUserName = passkey?.optString("userName") ?: "",
            raw = o,
        )
    }

    /**
     * Live entries in the desktop's display order: favourites first, then by
     * name. The desktop uses String.localeCompare for the name comparison, so
     * use a Collator rather than Kotlin's default ordering — otherwise case and
     * accents sort differently and the two clients disagree visibly.
     */
    fun liveSorted(data: VaultData): List<Entry> {
        val collator = java.text.Collator.getInstance().apply {
            strength = java.text.Collator.TERTIARY
        }
        return data.entries
            .filter { !it.isDeleted }
            .sortedWith(
                compareByDescending<Entry> { it.favorite }
                    .thenComparator { a, b ->
                        collator.compare(a.name.ifEmpty { a.url }, b.name.ifEmpty { b.url })
                    }
            )
    }
}
