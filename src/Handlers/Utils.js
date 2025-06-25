const { postSlackMessageWithRetry } = require("./slackApiUtils");
const { OpenAI } = require("openai");
const axios = require("axios");
const { syncCaisseToExcel } = require("../services/caisse/excelSyncService");
const Caisse = require("../database/dbModels/Caisse");

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY,
});

// Deduct Cash for Espèces Payments
async function deductCashForPayment(orderId, payment) {
	console.log("** deductCashForPayment");
	const caisse = await Caisse.findOne();
	if (!caisse || caisse.balances[payment.currency] < payment.amountPaid) {
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `Erreur: Solde caisse insuffisant pour paiement ${payment.amountPaid} ${payment.currency}`,
			},
			process.env.SLACK_BOT_TOKEN
		);
		throw new Error("Solde caisse insuffisant");
	}
	if (caisse.balances[payment.currency] < 50000) {
		// Example threshold
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_FINANCE_CHANNEL_ID,
				text: `⚠️ Alerte: Solde caisse bas (${
					caisse.balances[payment.currency]
				} ${payment.currency}). Envisagez de faire une demande de fonds.`,
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	caisse.balances[payment.currency] -= payment.amountPaid;
	caisse.transactions.push({
		type: "Payment",
		amount: payment.amountPaid,
		currency: payment.currency,
		orderId,
		details: `Paiement Espèces pour commande ${orderId}`,
	});

	await caisse.save();
	await syncCaisseToExcel(caisse);
}

const bankOptions = [
	{ text: { type: "plain_text", text: "AFGBANK CI" }, value: "AFGBANK_CI" },
	{
		text: { type: "plain_text", text: "AFRILAND FIRST BANK CI" },
		value: "AFRILAND_FIRST_BANK_CI",
	},
	{
		text: { type: "plain_text", text: "BOA - CÔTE D’IVOIRE" },
		value: "BOA_CI",
	},
	{
		text: { type: "plain_text", text: "BANQUE ATLANTIQUE CI (BACI)" },
		value: "BACI",
	},
	{
		text: { type: "plain_text", text: "BANQUE D’ABIDJAN" },
		value: "BANQUE_D_ABIDDAJAN",
	},
	{ text: { type: "plain_text", text: "BHCI" }, value: "BHCI" },
	{ text: { type: "plain_text", text: "BDU-CI" }, value: "BDU_CI" },
	{ text: { type: "plain_text", text: "BICICI" }, value: "BICICI" }, // Shortened from "BANQUE INTERNATIONALE POUR LE COMMERCE ET L’INDUSTRIE DE LA CÔTE D’IVOIRE"
	{ text: { type: "plain_text", text: "BNI" }, value: "BNI" },
	{
		text: { type: "plain_text", text: "BANQUE POPULAIRE CI" },
		value: "BANQUE_POPULAIRE",
	},
	{
		text: { type: "plain_text", text: "BSIC - CÔTE D’IVOIRE" },
		value: "BSIC_CI",
	}, // Shortened from "BANQUE SAHÉLO-SAHARIENNE POUR L’INVESTISSEMENT ET LE COMMERCE - CÔTE D’IVOIRE"
	{ text: { type: "plain_text", text: "BGFIBANK-CI" }, value: "BGFIBANK_CI" },
	{
		text: { type: "plain_text", text: "BRIDGE BANK GROUP CI" },
		value: "BBG_CI",
	},
	{ text: { type: "plain_text", text: "CITIBANK CI" }, value: "CITIBANK_CI" },
	{ text: { type: "plain_text", text: "CORIS BANK INTL CI" }, value: "CBI_CI" },
	{ text: { type: "plain_text", text: "ECOBANK CI" }, value: "ECOBANK_CI" },
	{ text: { type: "plain_text", text: "GTBANK-CI" }, value: "GTBANK_CI" },
	{ text: { type: "plain_text", text: "MANSA BANK" }, value: "MANSA_BANK" },
	{
		text: { type: "plain_text", text: "NSIA BANQUE CI" },
		value: "NSIA_BANQUE_CI",
	},
	{ text: { type: "plain_text", text: "ORABANK CI" }, value: "ORABANK_CI" },
	{
		text: { type: "plain_text", text: "ORANGE BANK AFRICA" },
		value: "ORANGE_BANK",
	},
	{
		text: { type: "plain_text", text: "SOCIETE GENERALE CI" },
		value: "SOCIETE_GENERALE_CI",
	},
	{ text: { type: "plain_text", text: "SIB" }, value: "SIB" },
	{ text: { type: "plain_text", text: "STANBIC BANK" }, value: "STANBIC_BANK" },
	{
		text: { type: "plain_text", text: "STANDARD CHARTERED CI" },
		value: "STANDARD_CHARTERED_CI",
	},
	{ text: { type: "plain_text", text: "UBA" }, value: "UBA" },
	{ text: { type: "plain_text", text: "VERSUS BANK" }, value: "VERSUS_BANK" },
	{ text: { type: "plain_text", text: "BMS CI" }, value: "BMS_CI" },
	{ text: { type: "plain_text", text: "BRM CI" }, value: "BRM_CI" },
	{ text: { type: "plain_text", text: "Autre" }, value: "Autre" },
];

const types = {
	wrong_amount: "Montant incorrect",
	wrong_payment_mode: "Mode de paiement incorrect",
	wrong_proof: "Justificatif manquant ou incorrect",
	wrong_bank_details: "Détails bancaires incorrects",
	other: "Autre problème",
};

// Helper to get Slack user info
async function getSlackUserName(userId) {
	try {
		const response = await axios.get("https://slack.com/api/users.info", {
			params: { user: userId },
			headers: {
				Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
			},
		});
		if (response.data.ok) {
			return response.data.user.real_name || response.data.user.name;
		}
		return null;
	} catch (error) {
		console.error("Error fetching Slack user info:", error);
		return null;
	}
}
// Helper to resolve display name to user ID and username
async function resolveUserIdAndName(identifier) {
	console.log("** resolveUserIdAndName");
	console.log(`Resolving user for identifier: ${identifier}`);

	const maxRetries = 5; // Maximum number of retries
	const baseDelay = 1000; // Initial delay in milliseconds

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await axios.get("https://slack.com/api/users.list", {
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
				},
			});

			if (response.data.ok) {
				// Try by real_name or username, but check for existence first
				let user = response.data.members.find(
					(u) =>
						(u.real_name &&
							u.real_name.toLowerCase() === identifier.toLowerCase()) ||
						(u.name && u.name.toLowerCase() === identifier.toLowerCase())
				);

				// Fallback: try by email prefix (before @)
				if (!user) {
					user = response.data.members.find(
						(u) =>
							u.profile &&
							u.profile.email &&
							u.profile.email.split("@")[0].toLowerCase() ===
								identifier.toLowerCase()
					);
				}

				if (user) {
					return { userId: user.id, userName: user.real_name || user.name };
				}
			}

			// If no user is found, return null
			return { userId: null, userName: null };
		} catch (error) {
			if (error.response && error.response.status === 429) {
				// Handle rate limit (HTTP 429)
				const retryAfter = error.response.headers["retry-after"]
					? parseInt(error.response.headers["retry-after"], 10) * 1000
					: baseDelay * attempt; // Use Retry-After header if available, otherwise exponential backoff

				console.warn(
					`Rate limit hit. Retrying in ${
						retryAfter / 1000
					} seconds... (Attempt ${attempt}/${maxRetries})`
				);

				await new Promise((resolve) => setTimeout(resolve, retryAfter));
			} else {
				// For other errors, log and rethrow
				console.error("Error resolving user ID and name:", error.message);
				throw error;
			}
		}
	}

	// If all retries fail, throw an error
	throw new Error(
		`Failed to resolve user ID and name for identifier: ${identifier} after ${maxRetries} attempts`
	);
}
async function parsePaymentFromText(text, context) {
	console.log("** parsePaymentFromText");
	try {
		const prompt = `
Parse the following text into a structured payment request object with these fields:
{
  "titre": "string",
  "date_requise": "string, in YYYY-MM-DD format",
  "motif": "string, reason for payment",
  "montant": "number, payment amount",
  "devise": "string, currency code (XOF, EUR, USD)",
  "bon_de_commande": "string, optional achat order number"
}

The input uses labels like "titre:", "date requise:", "motif:", "montant:", "devise:", "bon de commande:" followed by values. 
Extract only these fields and return a valid JSON string. If a field is missing, use reasonable defaults:
- devise defaults to 'XOF' if not specified
- date_requise defaults to today if not specified
- If montant includes currency (like "1000 XOF"), separate the amount and currency

Input text:
"${text}"
`;

		const timeoutPromise = new Promise((_, reject) =>
			setTimeout(() => reject(new Error("Request timed out")), 10000)
		);

		const openaiPromise = openai.chat.completions.create({
			model: "gpt-3.5-turbo",
			messages: [{ role: "user", content: prompt }],
			max_tokens: 300,
			temperature: 0.5,
		});

		const response = await Promise.race([openaiPromise, timeoutPromise]);
		const rawContent = response.choices[0].message.content.trim();
		context.log(`Raw OpenAI response: ${rawContent}`);

		let result;
		try {
			result = JSON.parse(rawContent);
		} catch (parseError) {
			context.log(
				`Failed to parse OpenAI response as JSON: ${parseError.message}`
			);
			throw new Error(`Invalid JSON from OpenAI: ${rawContent}`);
		}

		// Validate currency
		if (result.devise && !["XOF", "EUR", "USD"].includes(result.devise)) {
			result.devise = "XOF"; // Default to XOF if invalid currency
		}

		// Validate amount
		if (result.montant && (isNaN(result.montant) || result.montant <= 0)) {
			throw new Error("Invalid payment amount detected");
		}

		context.log("Parsed payment from AI:", JSON.stringify(result));
		return result;
	} catch (error) {
		context.log(`Error parsing payment with OpenAI: ${error.message}`);
		throw error;
	}
}

// Helper function to convert payment method codes to readable text
function getPaymentMethodText(method) {
	const methodMap = {
		cash: "Espèces",
		cheque: "Chèque",
		transfer: "Virement",
	};
	return methodMap[method] || method;
}
async function extractAndValidateUrl(url, justificatifs) {
	console.log("** extractAndValidateUrl");
	console.log("url1", url);

	// First check if url is null or undefined
	if (!url) {
		return true; // URL is optional, so null/undefined is valid
	}

	// Now we know url is not null/undefined, we can trim it
	const trimmedUrl = url.trim();

	if (trimmedUrl) {
		// Validate URL format
		if (isValidUrl(trimmedUrl)) {
			justificatifs.push({
				url: trimmedUrl,
				type: "url",
				createdAt: new Date(),
			});
			return true;
		} else {
			return false; // Invalid URL format
		}
	}

	return true; // Empty string after trimming is also valid
}
// 2. Create a function to extract justificatifs from form data
async function extractJustificatifs(formData, context, userId, slackToken) {
	try {
		console.log("** extractJustificatifs");
		const justificatifs = [];

		// Extract file uploads
		if (formData.justificatif?.input_justificatif?.files?.length > 0) {
			console.log(
				"formData.justificatif?.input_justificatif?.files?.length",
				formData.justificatif?.input_justificatif?.files?.length
			);
			formData.justificatif.input_justificatif.files.forEach((file) => {
				justificatifs.push({
					url: file.url_private,
					type: "file",
					createdAt: new Date(),
				});
			});
		}

		// Process URL justificatif if provided
		const justificatifUrl =
			formData?.justificatif_url?.input_justificatif_url?.value;
		console.log("justificatifs URL:", justificatifUrl);

		if (justificatifUrl) {
			let validURL = await extractAndValidateUrl(
				justificatifUrl,
				justificatifs,
				userId,
				slackToken
			);

			if (!validURL) {
				// Send error message to user via Slack
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: userId,
						text: "⚠️ L'URL du justificatif n'est pas valide. Votre demande a été enregistrée sans l'URL.",
					},
					slackToken
				);
			}
		}

		// Return the collected justificatifs, even if empty
		return justificatifs;
	} catch (error) {
		context.log(`Error extracting justificatifs: ${error}`);
		return [];
	}
}

// Helper function to validate URL format
function isValidUrl(string) {
	console.log("** isValidUrl");
	try {
		// eslint-disable-next-line no-undef
		new URL(string);
		return true;
	// eslint-disable-next-line no-unused-vars
	} catch (_) {
		return false;
	}
}

// Utility functions
function createImmediateResponse() {
	return {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};
}
module.exports = {
	deductCashForPayment,
	bankOptions,
	types,
	getPaymentMethodText,
	resolveUserIdAndName,
	parsePaymentFromText,
	extractJustificatifs,
	extractAndValidateUrl,
	getSlackUserName,
	createImmediateResponse,
	isValidUrl,
};
