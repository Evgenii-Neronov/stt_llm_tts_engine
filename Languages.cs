enum ConversationLanguage { Ru, En, De, Fr, Tl }

static class Languages
{
    public static bool TryParse(string? value, out ConversationLanguage language)
    {
        language = value?.Trim().ToLowerInvariant() switch
        {
            "en" => ConversationLanguage.En, "de" => ConversationLanguage.De,
            "fr" => ConversationLanguage.Fr, "tl" or "fil" => ConversationLanguage.Tl,
            _ => ConversationLanguage.Ru
        };
        return value?.Trim().ToLowerInvariant() is "ru" or "en" or "de" or "fr" or "tl" or "fil";
    }

    public static ConversationLanguage Parse(string? value) => TryParse(value, out var language) ? language : ConversationLanguage.Ru;
    public static string Code(this ConversationLanguage language) => language.ToString().ToLowerInvariant();
    public static string Name(this ConversationLanguage language) => language switch
    {
        ConversationLanguage.En => "English", ConversationLanguage.De => "German",
        ConversationLanguage.Fr => "French", ConversationLanguage.Tl => "Filipino (Tagalog)", _ => "Russian"
    };
    public static string Acknowledge(this ConversationLanguage language) => language switch
    {
        ConversationLanguage.En => "Sure, let's speak English.",
        ConversationLanguage.De => "Gerne, sprechen wir Deutsch.",
        ConversationLanguage.Fr => "Bien sûr, parlons français.",
        ConversationLanguage.Tl => "Sige, mag-Tagalog tayo.",
        _ => "Хорошо, продолжаем по-русски."
    };
    public static string Voice(this ConversationLanguage language, string? requested)
    {
        var primary = language.Voice();
        return language == ConversationLanguage.Ru && requested == "ru_RU-irina-medium" ? requested : primary;
    }

    public static string Voice(this ConversationLanguage language) => language switch
    {
        ConversationLanguage.En => "en_US-lessac-medium", ConversationLanguage.De => "de_DE-thorsten-medium",
        ConversationLanguage.Fr => "fr_FR-siwis-medium", ConversationLanguage.Tl => "tl_PH-filipino-medium",
        _ => "ru_RU-dmitri-medium"
    };
}
