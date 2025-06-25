const FormData1 = require("../../database/dbModels/FormData1");
const axios = require("axios");
const querystring = require("querystring");
// Parse filter arguments
function parseFilters(args) {
	console.log("** parseFilters");
	const filters = {};
	args.forEach((arg) => {
		const [key, ...valueParts] = arg.split(":");
		const value = valueParts.join(":"); // Handle values with colons
		if (key && value) {
			const trimmedKey = key.trim().toLowerCase();
			const trimmedValue = value.trim();
			if (trimmedKey === "titre") filters.titre = trimmedValue;
			if (trimmedKey === "statut" || trimmedKey === "status")
				filters.statut = trimmedValue; // Accept both
			if (trimmedKey === "date") filters.date = trimmedValue;
			if (trimmedKey === "demandeur") filters.demandeur = trimmedValue;
			if (trimmedKey === "equipe") filters.equipe = trimmedValue;
			if (trimmedKey === "autorisation_admin")
				filters.autorisation_admin = trimmedValue;
			if (trimmedKey === "paymentstatus") filters.paymentStatus = trimmedValue;
		}
	});
	return filters;
}
// Function to normalize team names by removing accents and converting to lowercase
function normalizeTeamName(teamName) {
	if (!teamName) return "Non spécifié";

	return teamName
		.normalize("NFD") // Decompose accented characters
		.replace(/[\u0300-\u036f]/g, "") // Remove accent marks
		.toLowerCase() // Convert to lowercase
		.trim(); // Remove leading/trailing spaces
}
// Helper function to remove accents
function removeAccents(str) {
	console.log("** removeAccents");
	return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
async function getFromStorage(key) {
	console.log("** getFromStorage");
	try {
		let result = await FormData1.findOne({ key }).exec();
		if (!result) {
			console.log(
				`Form data not found on first attempt for key: ${key}, retrying...`
			);
			await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s
			result = await FormData1.findOne({ key }).exec();
		}
		if (!result) {
			console.log(`Form data not found for key: ${key}`);
			return null;
		}
		console.log(`Retrieved form data for key: ${key}`);
		return result.data;
	} catch (err) {
		console.log(`Error retrieving form data for key ${key}:`, err);
		throw err;
	}
}
async function getChannelName(channelId, context) {
	if (!channelId) return "unknown";

	try {
		const result = await axios.post(
			"https://slack.com/api/conversations.info",

			querystring.stringify({ channel: channelId }),
			{
				headers: {
					Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
					"Content-Type": "application/x-www-form-urlencoded",
				},
			}
		);
		return result.data.ok ? result.data.channel.name : "unknown";
	} catch (error) {
		context.log(`Failed to get channel name: ${error.message}`);
		return "unknown";
	}
}

module.exports = {
	parseFilters,
	normalizeTeamName,
	removeAccents,
	getFromStorage,
	getChannelName,
};
