// config.js - Database configuration helpers
const Config = require("../database/dbModels/Config");
const { createSlackResponse } = require("../Handlers/slackApiUtils");

// Helper function to get config values from database
async function getConfigValues(key, defaultValues = []) {
	try {
		const config = await Config.findOne({ key });
		return config ? config.values : defaultValues;
	} catch (error) {
		console.error(`Error fetching config for ${key}:`, error);
		return defaultValues;
	}
}

// Helper function to update config values in database
async function updateConfigValues(key, values) {
	try {
		return await Config.findOneAndUpdate(
			{ key },
			{ values },
			{ upsert: true, new: true }
		);
	} catch (error) {
		console.error(`Error updating config for ${key}:`, error);
		throw error;
	}
}

// Helper function to add a single value to config
async function addConfigValue(key, value) {
	try {
		return await Config.findOneAndUpdate(
			{ key },
			{ $addToSet: { values: value } },
			{ upsert: true, new: true }
		);
	} catch (error) {
		console.error(`Error adding config value for ${key}:`, error);
		throw error;
	}
}

// Helper function to remove a single value from config
async function removeConfigValue(key, value) {
	try {
		return await Config.findOneAndUpdate(
			{ key },
			{ $pull: { values: value } },
			{ new: true }
		);
	} catch (error) {
		console.error(`Error removing config value for ${key}:`, error);
		throw error;
	}
}

// Get formatted options for Slack Select elements
async function getEquipeOptions() {
	const values = await getConfigValues("equipe_options", [
		"IT",
		"Finance",
		"Achat",
		"RH",
	]);
	return values.map((value) => ({
		text: { type: "plain_text", text: value },
		value: value.toLowerCase().replace(/\s+/g, "_"),
	}));
}

async function getUnitOptions() {
	const values = await getConfigValues("unit_options", [
		"pièce",
		"kg",
		"litre",
		"mètre",
	]);
	return values.map((value) => ({
		text: { type: "plain_text", text: value },
		value: value.toLowerCase().replace(/\s+/g, "_"),
	}));
}

async function getCurrencies() {
	const values = await getConfigValues("currencies", ["TND", "EUR", "USD"]);
	return values.map((value) => ({
		text: { type: "plain_text", text: value },
		value: value,
	}));
}
async function handleConfig(isAdmin) {
    if (!isAdmin) {
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: "🚫 Seuls les administrateurs peuvent configurer les options.",
        });
    }

    const equipeOptions = await getConfigValues("equipe_options", ["IT", "Finance", "Achat", "RH"]);
    const unitOptions = await getConfigValues("unit_options", ["pièce", "kg", "litre", "mètre"]);
    const currencies = await getConfigValues("currencies", ["TND", "EUR", "USD"]);

    return createSlackResponse(200, {
        response_type: "in_channel",
        text: `*Configuration actuelle:*\n\n*👥 Équipes:*\n${
            equipeOptions.length > 0
                ? equipeOptions.map((e) => `• ${e}`).join("\n")
                : "Aucune équipe configurée"
        }\n\n*📏 Unités:*\n${
            unitOptions.length > 0
                ? unitOptions.map((u) => `• ${u}`).join("\n")
                : "Aucune unité configurée"
        }\n\n*💰 Devises:*\n${
            currencies.length > 0
                ? currencies.map((c) => `• ${c}`).join("\n")
                : "Aucune devise configurée"
        }\n\n_Utilisez les commandes add/remove pour modifier._`,
    });
}

async function handleAddConfig(textArgs, isAdmin) {
    if (!isAdmin) {
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: "🚫 Seuls les administrateurs peuvent ajouter des configurations.",
        });
    }

    if (textArgs.length < 3) {
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: "Usage: `/order add [equipe|unit|currency] <valeur>`",
        });
    }

    const configType = textArgs[1];
    const value = textArgs.slice(2).join(" ");

    let configKey, displayName;

    switch (configType) {
        case "equipe":
            configKey = "equipe_options";
            displayName = "équipe";
            break;
        case "unit":
            configKey = "unit_options";
            displayName = "unité";
            break;
        case "currency":
            configKey = "currencies";
            displayName = "devise";
            break;
        default:
            return createSlackResponse(200, {
                response_type: "ephemeral",
                text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
            });
    }

    try {
        await addConfigValue(configKey, value);
        return createSlackResponse(200, {
            text: `✅ ${displayName.charAt(0).toUpperCase() + displayName.slice(1)} "${value}" ajoutée avec succès.`,
        });
    } catch (error) {
        console.error("Error adding config value:", error);
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: `❌ Erreur lors de l'ajout de la ${displayName}.`,
        });
    }
}

async function handleRemoveConfig(textArgs, isAdmin) {
    if (!isAdmin) {
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: "🚫 Seuls les administrateurs peuvent supprimer des configurations.",
        });
    }

    if (textArgs.length < 3) {
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: "Usage: `/order remove [equipe|unit|currency] <valeur>`",
        });
    }

    const configType = textArgs[1];
    const value = textArgs.slice(2).join(" ");

    let configKey, displayName;

    switch (configType) {
        case "equipe":
            configKey = "equipe_options";
            displayName = "équipe";
            break;
        case "unit":
            configKey = "unit_options";
            displayName = "unité";
            break;
        case "currency":
            configKey = "currencies";
            displayName = "devise";
            break;
        default:
            return createSlackResponse(200, {
                response_type: "ephemeral",
                text: "❌ Type invalide. Utilisez: equipe, unit, ou currency",
            });
    }

    try {
        await removeConfigValue(configKey, value);
        return createSlackResponse(200, {
            text: `✅ ${displayName.charAt(0).toUpperCase() + displayName.slice(1)} "${value}" supprimée avec succès.`,
        });
    } catch (error) {
        console.error("Error removing config value:", error);
        return createSlackResponse(200, {
            response_type: "ephemeral",
            text: `❌ Erreur lors de la suppression de la ${displayName}.`,
        });
    }
}
module.exports = {
	getConfigValues,
	updateConfigValues,
	addConfigValue,
	removeConfigValue,
	getEquipeOptions,
	getUnitOptions,
	getCurrencies,
	handleConfig,
    handleAddConfig,
    handleRemoveConfig
};
