const Order = require("../database/dbModels/Order");
const {
	postSlackMessageWithRetry,
	createSlackResponse,
	getFileInfo,
} = require("../Handlers/slackApiUtils");
const { getCurrencies } = require("./configService");
const {
	notifyAdminProforma,
	notifyTeams,
} = require("./Notifications/Proforma");

// Handler for final deletion of proforma
async function handleDeleteProforma(payload, context) {
	try {
		console.log("** handleDeleteProforma");
		// Extract data from the modal submission
		const { orderId, proformaIndex } = JSON.parse(
			payload.view.private_metadata
		);

		// Get the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		// Check if the proforma is already validated
		if (order.proformas[proformaIndex].validated) {
			return {
				response_action: "errors",
				errors: {
					delete_proforma_confirmation:
						"Cette proforma a déjà été validée et ne peut pas être supprimée.",
				},
			};
		}

		// Store the proforma details for the notification
		const deletedProforma = order.proformas[proformaIndex];

		// Remove the proforma from the array
		order.proformas.splice(proformaIndex, 1);

		// Save the updated order
		await order.save();

		// Notify admin about the deletion
		await notifyAdminProforma(order, context);

		// Post confirmation message to achat channel
		await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: `✅ Proforma supprimée: *${deletedProforma.nom}* - ${deletedProforma.montant} ${deletedProforma.devise} pour la commande ${orderId}`,
			},
			process.env.SLACK_BOT_TOKEN
		);

		return { response_action: "clear" };
	} catch (error) {
		context.log(`Error in handleDeleteProforma: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				delete_proforma_confirmation: `❌ Erreur lors de la suppression: ${error.message}`,
			},
		};
	}
}
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

// Add validation for the proforma amount and currency
async function validateProformaAmount(value) {
	console.log("** validateProformaAmount");
	// If value is undefined, null, or an empty string, treat it as valid with no amount
	if (!value || typeof value !== "string" || value.trim() === "") {
		return { valid: true, normalizedValue: null }; // No amount provided, still valid
	}

	// Extract the amount and currency
	const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)$/);

	if (!match) {
		return {
			valid: false,
			error:
				"⚠️ Format invalide. Veuillez entrer un montant suivi d'une devise (ex: 1000 XOF).",
		};
	}

	const [, amount, currency] = match;
	// Fetch valid currencies from DB
	const currencyOptions = await getCurrencies();
	if (!currencyOptions || currencyOptions.length === 0) {
		return {
			valid: false,
			error: "⚠️ Aucune devise valide trouvée dans la base de données.",
		};
	}

	const validCurrencies = currencyOptions.map((opt) => opt.value.toUpperCase());

	if (!validCurrencies.includes(currency.toUpperCase())) {
		return {
			valid: false,
			error: `⚠️ Devise non reconnue. Les devises acceptées sont: ${validCurrencies.join(
				", "
			)}.`,
		};
	}

	// Check if the amount is a valid number
	const numericAmount = parseFloat(amount);
	if (isNaN(numericAmount) || numericAmount <= 0) {
		return {
			valid: false,
			error: "⚠️ Le montant doit être un nombre positif.",
		};
	}

	return {
		valid: true,
		normalizedValue: `${numericAmount} ${currency.toUpperCase()}`,
	};
}

async function extractProformas(formData, context, i, userId) {
	console.log("** extractProformas");
	// Initialize collections
	const urls = [];
	const file_ids = [];
	let totalPages = 0;

	// Get common fields
	const designation = formData.proforma_designation?.designation_input?.value;
	const amountString = formData.proforma_amount?.input_proforma_amount?.value;
	// Validate the amount and currency
	const validationResult = await validateProformaAmount(amountString);
	console.log("!validationResult.valid", !validationResult.valid);
	let fournisseur = "";
	if (formData.proforma_fournisseur?.fournisseur_input?.value) {
		fournisseur = formData.proforma_fournisseur?.fournisseur_input?.value;
		console.log("proforma_fournisseur1", fournisseur);
	}
	if (!validationResult.valid) {
		let messageText = `${validationResult.error} `;
		let slackResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{ channel: userId, text: messageText },
			process.env.SLACK_BOT_TOKEN
		);

		if (!slackResponse.ok) {
			context.log(`${slackResponse.error}`);
		}

		return validationResult;
	}

	// Process file uploads
	const proformaFiles = formData.proforma_file?.file_upload?.files || [];
	if (proformaFiles.length > 0) {
		for (const file of proformaFiles) {
			const fileInfo = await getFileInfo(file.id, process.env.SLACK_BOT_TOKEN);
			urls.push(fileInfo.url_private);
			file_ids.push(file.id);
		}
		totalPages += proformaFiles.length;
	}

	// Process manual URL

	if (formData.proforma_url?.input_proforma_url?.value) {
		const proformaUrl = formData.proforma_url?.input_proforma_url?.value.trim();
		if (proformaUrl) {
			// Validate URL format
			if (isValidUrl(proformaUrl)) {
				urls.push(proformaUrl);
				totalPages += 1; // Count URL as 1 page
			} else if (!isValidUrl(proformaUrl)) {
				// Send error message to user
				await postSlackMessageWithRetry(
					"https://slack.com/api/chat.postMessage",
					{
						channel: userId,
						text: "⚠️ L'URL du justificatif n'est pas valide. Votre demande a été enregistrée sans l'URL.",
					},
					process.env.SLACK_BOT_TOKEN
				);
			}
		}
	}

	// If no proforma files or URL were provided, return an empty array
	if (urls.length === 0) {
		return [];
	}

	// Validation
	if (!amountString) {
		context.log("Proforma provided but no amount");
		throw new Error("Veuillez fournir un montant pour la proforma.");
	}

	// Parse amount
	let amount = null;
	let validCurrency = "";
	if (amountString) {
		const match = amountString.match(/(\d+(?:\.\d+)?)\s*([A-Za-z]+)/);
		if (!match) {
			throw new Error(
				`Format de montant invalide: ${amountString}. Utilisez '1000 XOF'.`
			);
		}

		amount = parseFloat(match[1]);
		const currency = match[2].toUpperCase();
		console.log("currency2", currency);
		// Fetch valid currencies from DB
		const currencyOptions = await getCurrencies();
		if (!currencyOptions || currencyOptions.length === 0) {
			return {
				valid: false,
				error: "⚠️ Aucune devise valide trouvée dans la base de données.",
			};
		}

		const validCurrencies = currencyOptions.map((opt) =>
			opt.value.toUpperCase()
		);

		if (!validCurrencies.includes(currency.toUpperCase())) {
			return {
				valid: false,
				error: `⚠️ Devise non reconnue. Les devises acceptées sont: ${validCurrencies.join(
					", "
				)}.`,
			};
		} else {
			validCurrency = currency;
		}
	}
	let validated;
	if (i == 1) {
		validated = true;
	} else if (i == 0) {
		validated = false;
	}
	// Return single proforma entry with all pages
	return [
		{
			file_ids,
			urls,
			nom: designation || `Proforma (${urls.length} pages)`,
			montant: amount,
			devise: validCurrency,
			pages: totalPages,
			validated: validated,
			fournisseur: fournisseur,
		},
	];
}
async function proforma_form(payload) {
	console.log("** proforma_form");
	const orderId = payload.actions[0].value; // Extract order ID from the button
	//  context.log(`Opening proforma form for order: ${orderId}`);
	// Fetch the order from the database
	const order = await Order.findOne({ id_commande: orderId });
	if (!order) {
		console.log(`❌ Order not found: ${orderId}`);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: "Erreur : Commande non trouvée.",
		});
	}

	// Check the number of proformas (assuming proformas is an array in the order document)
	const proformaCount = order.proformas ? order.proformas.length : 0;
	console.log(`Order ${orderId} has ${proformaCount} proformas`);
	// Check if any proforma is validated by admin
	const hasValidatedProforma =
		order.proformas && order.proformas.some((proforma) => proforma.validated);
	console.log(
		`Order ${orderId} has validated proforma: ${hasValidatedProforma}`
	);
	if (proformaCount >= 5) {
		console.log(`❌ Proforma limit reached for order: ${orderId}`);
		return await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: "❌ Limite atteinte : Vous ne pouvez pas ajouter plus de 5 proformas à cette commande.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	if (hasValidatedProforma) {
		console.log(
			`❌ Admin has already validated a proforma for order: ${orderId}`
		);

		return await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				text: "⚠️ Une proforma a déjà été validé par l'admin pour cette commande.",
			},
			process.env.SLACK_BOT_TOKEN
		);
	}
	// Define the modal view with both file upload and URL input
	const modalView = {
		type: "modal",
		callback_id: "proforma_submission",
		title: {
			type: "plain_text",
			text: "Ajouter des Proformas",
			emoji: true,
		},
		submit: {
			type: "plain_text",
			text: "Enregistrer",
			emoji: true,
		},
		close: {
			type: "plain_text",
			text: "Annuler",
			emoji: true,
		},
		blocks: [
			{
				type: "input",
				block_id: "proforma_designation",
				element: {
					type: "plain_text_input",
					action_id: "designation_input",
					placeholder: {
						type: "plain_text",
						text: "N° proforma fournisseur ou autre.",
					},
				},
				label: {
					type: "plain_text",
					text: "Référence",
				},
			},
			{
				type: "input",
				block_id: "proforma_fournisseur",
				optional: false,
				element: {
					type: "plain_text_input",
					action_id: "fournisseur_input",
				},
				label: {
					type: "plain_text",
					text: "Fournisseur",
				},
			},
			{
				type: "input",
				block_id: `proforma_amount`,
				label: { type: "plain_text", text: "💰 Montant" },
				element: {
					type: "plain_text_input",
					action_id: `input_proforma_amount`,
					placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				},
				hint: {
					type: "plain_text",
					text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
				},
			},
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Choisissez une option:* Télécharger des fichiers ou saisir l'URL de la proforma",
				},
			},
			{
				type: "input",
				block_id: `proforma_file`,
				optional: true,
				label: {
					type: "plain_text",
					text: `📎 Fichier(s) Proforma`,
				},
				element: {
					type: "file_input",
					action_id: `file_upload`,
					filetypes: ["pdf", "jpg", "png"],
					max_files: 5,
				},
			},
			{
				type: "input",
				block_id: `proforma_url`,
				optional: true,
				label: {
					type: "plain_text",
					text: `🔗 URL Proforma`,
				},
				element: {
					type: "plain_text_input",
					action_id: `input_proforma_url`,
					placeholder: { type: "plain_text", text: "https://..." },
				},
			},
		],
		private_metadata: JSON.stringify({ orderId }), // Pass orderId to submission handler
	};

	try {
		const response = await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: modalView,
			},
			process.env.SLACK_BOT_TOKEN
		);

		if (!response.ok) {
			//  context.log(`❌ views.open failed: ${response.error}`);
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: `Erreur: ${response.error}`,
			});
		}

		//  context.log("Proforma form with file upload and URL input opened successfully");
		return {
			statusCode: 200,
			headers: { "Content-Type": "application/json" },
			body: "",
		};
			// eslint-disable-next-line no-unused-vars
	} catch (error) {
		return {
			statusCode: 500,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				response_type: "ephemeral",
				text: "Erreur lors de l'ouverture du formulaire.",
			}),
		};
	}
}
// Handler for edit_proforma_submission
async function handleEditProformaSubmission(payload, context) {
	try {
		console.log("** handleEditProformaSubmission");
		const { view } = payload;
		const { orderId, proformaIndex, existingUrls, existingFileIds } =
			JSON.parse(view.private_metadata);

		// Extract form values
		const designation =
			view.state.values.proforma_designation.designation_input.value;
		const amountInput =
			view.state.values.proforma_amount.input_proforma_amount.value;

		const fournisseur =
			view.state.values.proforma_fournisseur.fournisseur_input.value;
		console.log("fournisseur", fournisseur);
		console.log("amountInput", amountInput);

		// Parse amount and currency
		const amountMatch = amountInput.match(/(\d+(?:\.\d+)?)\s*([A-Z]{3})/);
		if (!amountMatch) {
			return await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,

					text: "⚠️ Le format du montant est incorrect. Exemple attendu: 1000 XOF",
				},
				process.env.SLACK_BOT_TOKEN
			);
		}

		const amount = parseFloat(amountMatch[1]);
		const currency = amountMatch[2];
		console.log("111111");

		if (!["XOF", "EUR", "USD"].includes(currency)) {
			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Erreur: Devise non reconnue. Les devises acceptées sont: XOF, USD, EUR. Veuillez modifier votre demande.",
				},
				process.env.SLACK_BOT_TOKEN
			);

			return { response_action: "clear" };
		}
		console.log("currency", currency);
		console.log("amount", amount);

		const montant = parseFloat(amountMatch[1]);
		const devise = amountMatch[2].toUpperCase();

		// Check if we should keep existing files/URLs
		const keepExistingCheckbox =
			view.state.values.keep_existing_files?.input_keep_existing
				?.selected_options || [];
		const keepExisting = keepExistingCheckbox.some(
			(option) => option.value === "keep"
		);

		// Collect all URLs and file IDs
		let updatedUrls = [];
		let updatedFileIds = [];

		// If keeping existing, start with the existing values
		if (keepExisting) {
			existingUrls.forEach((_, index) => {
				const blockId = `existing_url_${index}`;
				if (view.state.values[blockId]?.[`edit_url_${index}`]) {
					const updatedUrl =
						view.state.values[blockId][`edit_url_${index}`].value;
					if (updatedUrl && updatedUrl.trim()) {
						updatedUrls.push(updatedUrl.trim());
					}
				}
			});
			updatedFileIds = [...existingFileIds];
		}

		// Handle new URL
		const newUrl =
			view.state.values.new_proforma_url?.input_new_proforma_url?.value;
		if (newUrl && newUrl.trim()) {
			updatedUrls.push(newUrl.trim());
		}

		// Handle new file upload
		const newFiles = view.state.values.proforma_file?.file_upload?.files || [];
		if (newFiles.length > 0) {
			for (const file of newFiles) {
				updatedUrls.push(file.url_private); // Add file URL to URLs
				updatedFileIds.push(file.id); // Add file ID to file_ids
			}
		}

		// Initialize updateData with base values
		const updateData = {
			nom: designation,
			montant: montant,
			devise: devise,
			fournisseur: fournisseur,
			pages: updatedUrls.length, // Update page count based on total URLs
		};

		// Only set URLs and file_ids if they changed or we're not keeping existing
		if (updatedUrls.length > 0 || !keepExisting) {
			updateData.urls = updatedUrls;
		}
		if (updatedFileIds.length > 0 || !keepExisting) {
			updateData.file_ids = updatedFileIds;
		}

		// Update the proforma in the database
		const updatedOrder = await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{ $set: { [`proformas.${proformaIndex}`]: updateData } },
			{ new: true }
		);

		if (!updatedOrder) {
			throw new Error(`Failed to update proforma for order ${orderId}`);
		}

		// Update the Slack message with the new proforma details
		await notifyAdminProforma(updatedOrder, context);

		return {
			response_action: "clear",
		};
	} catch (error) {
		context.log(`Error in handleEditProformaSubmission: ${error.message}`);
		return {
			response_action: "errors",
			errors: {
				proforma_amount: error.message,
			},
		};
	}
}

// New function to handle proforma submission
async function handleProformaSubmission(payload, context) {
	console.log("** handleProformaSubmission");
	const { orderId } = JSON.parse(payload.view.private_metadata);
	const values = payload.view.state.values;
	context.log("payload11112", payload);

	context.log("orderId", orderId);
	context.log("values", JSON.stringify(values));
	let userId = payload.user.id;

	try {
		let timestampedProformas;
		// Use the extractProformas function to process all proforma data
		const proformaDataArray = await extractProformas(
			values,
			context,
			0,
			userId
		);
		console.log("proformaDataArray2", proformaDataArray);

		if (proformaDataArray.valid == false) {
			console.log("proformaDataArray1", proformaDataArray);
			return { response_action: "clear" };
		} else {
			// Add createdAt timestamp to each proforma

			timestampedProformas = proformaDataArray.map((proforma) => ({
				...proforma,
				createdAt: new Date(),
			}));
		}

		// Update the order in MongoDB with all proforma entries
		const updatedOrder = await Order.findOneAndUpdate(
			{ id_commande: orderId },
			{ $push: { proformas: { $each: timestampedProformas } } },
			{ new: true }
		);

		if (!updatedOrder) {
			throw new Error(`Order ${orderId} not found`);
		}

		context.log("Updated order with proformas:", JSON.stringify(updatedOrder));

		// Prepare notification message
		let messageText;

		if (proformaDataArray.length === 1) {
			const proforma = proformaDataArray[0];
			const hasFile = !!proforma.file_id;
			messageText = `✅ Proforma ajoutée pour *${orderId}*: ${proforma.nom} - ${
				proforma.montant
			} ${proforma.devise}${
				hasFile ? ` avec fichier <${proforma.url}|voir>` : ` (URL)`
			}`;
		} else {
				// eslint-disable-next-line no-unused-vars
			messageText = `✅ ${
				proformaDataArray.length
			} proformas ajoutées pour *${orderId}* (Total: ${proformaDataArray.reduce(
				(sum, p) => sum + p.montant,
				0
			)} ${proformaDataArray[0].devise})`;
		}
		try {
			// Notify admin
			await notifyAdminProforma(updatedOrder, context);
		} catch (notifyError) {
			context.log(`WARNING: Admin notification failed: ${notifyError.message}`);
			// Continue execution even if admin notification fails
		}
		// // Post Slack message to the designated channel
		// const slackResponse = await postSlackMessageWithRetry(
		//   "https://slack.com/api/chat.postMessage",
		//   { channel: process.env.SLACK_ACHAT_CHANNEL_ID, text: messageText },
		//   process.env.SLACK_BOT_TOKEN
		// );

		// if (!slackResponse.ok) {
		//   context.log(`${slackResponse.error}`);
		// }
		return { response_action: "clear" };
	} catch (error) {
		const slackResponse = await postSlackMessageWithRetry(
			"https://slack.com/api/chat.postMessage",
			{
				channel: process.env.SLACK_ACHAT_CHANNEL_ID,
				// text: `Error in proforma submission: ${error.message}`,
				text: "❌ Veuillez charger au moins une proforma avant de continuer.",
			},
			process.env.SLACK_BOT_TOKEN
		);
		if (!slackResponse.ok) {
			context.log(`❌ Slack message failed: ${slackResponse.error}`);
		}
		context.log(
			`❌ Error in proforma submission: ${error.message}`,
			error.stack
		);
		return {
			response_action: "errors",
			errors: {
				proforma_submission: `❌ Erreur lors de l'enregistrement des proformas: ${error.message}`,
			},
		};
	}
}
async function handleProformaValidationConfirm(payload, context) {
	console.log("** proforma_validation_confirm");

	// Immediate response
	const immediateResponse = {
		status: 200,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ response_action: "clear" }),
	};

	// Process in background
	setImmediate(async () => {
		try {
			await handleProformaValidationConfirm(payload, context);
		} catch (error) {
			const orderId = payload.view?.private_metadata
				? JSON.parse(payload.view.private_metadata).orderId
				: "unknown";

			context.log(
				`Background processing error for proforma submission (order: ${orderId}): ${error.message}\nStack: ${error.stack}`
			);

			await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: payload.user.id,
					text: `❌ Erreur lors du traitement de la proforma pour la commande ${orderId}. Veuillez contacter le support.`,
				},
				process.env.SLACK_BOT_TOKEN
			);
		}
	});

	return immediateResponse;
}
// async function handleProformaValidationConfirm(payload, context) {
// 	console.log("** handleProformaValidationConfirm");
// 	try {
// 		console.log("payload1", payload);
// 		const values = payload.view.state.values;
// 		const comment = values.validation_data?.comment?.value || "";
// 		const metadata = JSON.parse(payload.view.private_metadata || "{}");
// 		const { orderId, proformaIndex } = metadata;

// 		console.log("Validation1");
// 		await validateProforma(
// 			{
// 				...payload,
// 				actions: [
// 					{
// 						value: JSON.stringify({
// 							orderId: orderId,
// 							proformaIndex: proformaIndex,
// 							comment: comment,
// 						}),
// 					},
// 				],
// 			},
// 			context
// 		);

// 		return {
// 			response_action: "clear",
// 		};
// 	} catch (error) {
// 		context.log(
// 			`Error in handleProformaValidationConfirm: ${error.message}`,
// 			error.stack
// 		);
// 		throw error;
// 	}
// }
async function handleDeleteProformaConfirmation(payload, context) {
	console.log("** handleDeleteProformaConfirmation");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);

		// Fetch the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		// const proforma = order.proformas[proformaIndex];

		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			if (!slackResponse.ok) {
				context.log(`❌ Slack message failed: ${slackResponse.error}`);
			}
			// return {
			//   text: ,
			//   replace_original: false,
			//   response_type: "ephemeral"
			// };
		} else {
			// Open a confirmation dialog
			const modalView = {
				type: "modal",
				callback_id: "delete_proforma_confirmation",
				title: {
					type: "plain_text",
					text: "Confirmer la suppression",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Supprimer",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: "⚠️ Êtes-vous sûr de vouloir supprimer cette proforma ? Cette action est irréversible.",
						},
					},
				],
				private_metadata: JSON.stringify({ orderId, proformaIndex }),
			};

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(
					`Failed to open deletion confirmation: ${response.error}`
				);
			}
		}

		return { text: "Chargement de la confirmation de suppression..." };
	} catch (error) {
		context.log(`Error in handleDeleteProformaConfirmation: ${error.message}`);
		return {
			text: `❌ Erreur lors de la confirmation de suppression: ${error.message}`,
		};
	}
}
// Handler for edit_proforma action
async function handleEditProforma(payload, context) {
	console.log("** handleEditProforma");
	try {
		// Extract data from the button value
		const { orderId, proformaIndex } = JSON.parse(payload.actions[0].value);

		// Fetch the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			throw new Error(`Order ${orderId} not found`);
		}

		// Check if the proforma exists
		if (!order.proformas || !order.proformas[proformaIndex]) {
			throw new Error(
				`Proforma index ${proformaIndex} not found in order ${orderId}`
			);
		}

		const proforma = order.proformas[proformaIndex];
		// Check if any proforma in the order is already validated
		const hasValidatedProforma = order.proformas.some((p) => p.validated);
		if (hasValidatedProforma) {
			// Post Slack message to the designated channel
			const slackResponse = await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ACHAT_CHANNEL_ID,
					text: "⚠️ Une proforma a été validée.",
				},
				process.env.SLACK_BOT_TOKEN
			);
			if (!slackResponse.ok) {
				context.log(`❌ Slack message failed: ${slackResponse.error}`);
			}
			return {
				text: "⚠️ Une proforma a été validée.",
				replace_original: false,
				response_type: "ephemeral",
			};
		} else {
			// Create blocks for the existing URLs
			const urlBlocks = [];

			// Add header for existing files/URLs section if there are any
			if (proforma.urls && proforma.urls.length > 0) {
				urlBlocks.push({
					type: "section",
					block_id: "existing_urls_header",
					text: {
						type: "mrkdwn",
						text: "*Pages/URLs existantes:*",
					},
				});

				// Add each existing URL as a separate input field
				proforma.urls.forEach((url, index) => {
					urlBlocks.push({
						type: "input",
						block_id: `existing_url_${index}`,
						optional: true,
						label: {
							type: "plain_text",
							text: `🔗 Page ${index + 1}`,
						},
						element: {
							type: "plain_text_input",
							action_id: `edit_url_${index}`,
							initial_value: url,
						},
					});
				});

				// Add divider after existing URLs
				urlBlocks.push({
					type: "divider",
				});
			}

			// Create the edit form with pre-filled values
			const modalView = {
				type: "modal",
				callback_id: "edit_proforma_submission",
				title: {
					type: "plain_text",
					text: "Modifier la Proforma",
					emoji: true,
				},
				submit: {
					type: "plain_text",
					text: "Mettre à jour",
					emoji: true,
				},
				close: {
					type: "plain_text",
					text: "Annuler",
					emoji: true,
				},
				blocks: [
					{
						type: "input",
						block_id: "proforma_designation",
						element: {
							type: "plain_text_input",
							action_id: "designation_input",
							initial_value: proforma.nom || "",
						},
						label: {
							type: "plain_text",
							text: "Référence",
						},
					},
					{
						type: "input",
						block_id: "proforma_fournisseur",
						optional: false,
						element: {
							type: "plain_text_input",
							action_id: "fournisseur_input",
							initial_value: proforma.fournisseur || "",
						},
						label: {
							type: "plain_text",
							text: "Fournisseur",
						},
					},
					{
						type: "input",
						block_id: "proforma_amount",
						label: { type: "plain_text", text: "💰 Montant" },
						element: {
							type: "plain_text_input",
							action_id: "input_proforma_amount",
							initial_value: `${proforma.montant} ${proforma.devise}`,
							placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
						},
						hint: {
							type: "plain_text",
							text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
						},
					},
					// Add the existing URLs blocks
					...urlBlocks,
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: " Télécharger de nouveaux fichiers ou ajouter de nouvelles URLs",
						},
					},
					{
						type: "input",
						block_id: "proforma_file",
						optional: true,
						label: {
							type: "plain_text",
							text: "📎 Nouveaux fichiers",
						},
						element: {
							type: "file_input",
							action_id: "file_upload",
							filetypes: ["pdf", "jpg", "png"],
							max_files: 5,
						},
						hint: {
							type: "plain_text",
							text: "Si vous souhaitez conserver les fichiers existants, ne téléchargez pas de nouveaux fichiers.",
						},
					},
					{
						type: "input",
						block_id: "new_proforma_url",
						optional: true,
						label: {
							type: "plain_text",
							text: "🔗 Nouvelle URL",
						},
						element: {
							type: "plain_text_input",
							action_id: "input_new_proforma_url",
							placeholder: { type: "plain_text", text: "https://..." },
						},
						hint: {
							type: "plain_text",
							text: "Ajouter une nouvelle URL à cette proforma.",
						},
					},
					{
						type: "input",
						block_id: "keep_existing_files",
						optional: true,
						label: {
							type: "plain_text",
							text: "Conservation des fichiers existants",
						},
						element: {
							type: "checkboxes",
							action_id: "input_keep_existing",
							initial_options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
							options: [
								{
									text: {
										type: "plain_text",
										text: "Conserver les fichiers/URLs existants",
									},
									value: "keep",
								},
							],
						},
					},
				],
				private_metadata: JSON.stringify({
					orderId,
					proformaIndex,
					existingUrls: proforma.urls || [],
					existingFileIds: proforma.file_ids || [],
				}),
			};

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: modalView,
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				throw new Error(`Failed to open edit form: ${response.error}`);
			}
		}

		return { text: "Chargement du formulaire de modification..." };
	} catch (error) {
		context.log(`Error in handleEditProforma: ${error.message}`);
		return {
			text: `❌ Erreur lors de l'ouverture du formulaire: ${error.message}`,
			replace_original: false,
			response_type: "ephemeral",
		};
	}
}
// Add a new handler for the confirmation modal

async function handleProformaValidationRequest(payload, context) {
	console.log("** handleProformaValidationRequest");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const order = await Order.findOne({ id_commande: value.orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}

		// Check if a proforma is already validated
		const alreadyValidated = order.proformas.some((p) => p.validated);
		if (alreadyValidated) {
			return await postSlackMessageWithRetry(
				"https://slack.com/api/chat.postMessage",
				{
					channel: process.env.SLACK_ADMIN_ID,
					text: "❌ Une proforma a déjà été validée pour cette commande.",
				},
				process.env.SLACK_BOT_TOKEN
			);
		} else {
			console.log("value1", value);

			const response = await postSlackMessageWithRetry(
				"https://slack.com/api/views.open",
				{
					trigger_id: payload.trigger_id,
					view: {
						type: "modal",
						callback_id: "proforma_validation_confirm",
						private_metadata: JSON.stringify({
							orderId: value.orderId,
							proformaIndex: value.proformaIndex,
							proformaName: value.proformaName, // Optional, for display
							proformaAmount: value.proformaAmount, // Optional, for display
						}),
						title: {
							type: "plain_text",
							text: " Validation",
							emoji: true,
						},
						submit: {
							type: "plain_text",
							text: "Valider",
							emoji: true,
						},
						close: {
							type: "plain_text",
							text: "Annuler",
							emoji: true,
						},
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `Êtes-vous sûr de vouloir valider cette proforma?`,
								},
							},
							{
								type: "section",
								text: {
									type: "mrkdwn",

									text: `*Commande:* ${
										value.orderId
									}\n*Proforma:*\n*URLs:*\n${order.proformas?.[
										value.proformaIndex
									]?.urls
										.map((url, j) => `  ${j + 1}. <${url}|Page ${j + 1}>`)
										.join("\n")} \n*Montant:* ${
										order.proformas?.[value.proformaIndex]?.montant
									} ${order.proformas?.[value.proformaIndex]?.devise}`,
								},
							},
							{
								type: "input",
								block_id: "validation_data",
								optional: true,
								label: {
									type: "plain_text",
									text: "Commentaire (optionnel)",
									emoji: true,
								},
								element: {
									type: "plain_text_input",
									action_id: "comment",
								},
							},
						],
					},
				},
				process.env.SLACK_BOT_TOKEN
			);

			if (!response.ok) {
				context.log(`Failed to open confirmation modal: ${response.error}`);
				throw new Error(`Modal open failure: ${response.error}`);
			}

			return response;
		}
	} catch (error) {
		context.log(
			`Error in handleProformaValidationRequest: ${error.message}`,
			error.stack
		);
		throw error;
	}
}

async function validateProforma(payload, context) {
	console.log("** validateProforma");
	try {
		const value = JSON.parse(payload.actions[0].value);
		const { orderId, proformaIndex, comment } = value;
		console.log("val11");
		// Find the order
		const order = await Order.findOne({ id_commande: orderId });
		if (!order) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Commande non trouvée.",
			});
		}

		// Check if any proforma is already validated
		const alreadyValidated = order.proformas.some((p) => p.validated);
		if (alreadyValidated) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Une proforma a déjà été validée pour cette commande.",
			});
		}

		// Validate the proforma
		const proformaToValidate = order.proformas[proformaIndex];
		if (!proformaToValidate) {
			return createSlackResponse(200, {
				response_type: "ephemeral",
				text: "❌ Erreur : Proforma non trouvée.",
			});
		}

		// Update the proforma with validation info
		proformaToValidate.validated = true;
		proformaToValidate.validatedAt = new Date();
		proformaToValidate.validatedBy = payload.user.id;
		if (comment) {
			proformaToValidate.validationComment = comment;
		}

		// Save the updated order
		await order.save();

		// Notify both admin and achat channels with updated message
		await notifyAdminProforma(order, context, proformaIndex);

		// // Post a confirmation message to the thread
		// const slackResponse = await postSlackMessageWithRetry(
		//   "https://slack.com/api/chat.postMessage",
		//   {
		//     channel: process.env.SLACK_ADMIN_ID,
		//     text: `:white_check_mark: Proforma ${
		//       proformaToValidate.nom || `#${parseInt(proformaIndex) + 1}`
		//     } validée par <@${payload.user.id}>${
		//       comment ? ` avec commentaire: "${comment}"` : ""
		//     }.`,
		//     blocks: [
		//       {
		//         type: "section",
		//         text: {
		//           type: "mrkdwn",
		//           text: `:white_check_mark: Proforma ${
		//             proformaToValidate.nom || `#${parseInt(proformaIndex) + 1}`
		//           } validée par <@${payload.user.id}>${
		//             comment ? ` avec commentaire: "${comment}"` : ""
		//           }.`,
		//         },
		//       },
		//       {
		//         type: "actions",
		//         elements: [
		//           // {
		//           //   type: "button",
		//           //   text: {
		//           //     type: "plain_text",
		//           //     text: "Annuler la valdation",
		//           //     emoji: true,
		//           //   },
		//           //   style: "danger", // Moved style to button level
		//           //   value: `proforma_${proformaIndex}`,
		//           //   action_id: "delete_confirmation",
		//           // },
		//           {
		//             type: "button",
		//             text: {
		//               type: "plain_text",
		//               text: "Supprimer la commande",
		//               emoji: true,
		//             },
		//             style: "danger", // Moved style to button level
		//             value: `proforma_${proformaIndex}`,
		//             action_id: "delete_order",
		//           },
		//         ],
		//       },
		//     ],
		//   },
		//   process.env.SLACK_BOT_TOKEN
		// );

		// if (!slackResponse.ok) {
		//   context.log(
		//     `Error posting Slack message: ${
		//       slackResponse.error
		//     }, Details: ${JSON.stringify(slackResponse)}`
		//   );
		// }
		const actionValue = JSON.parse(payload.actions[0].value);
		// Extract the orderId from the parsed object
		const orderId1 = actionValue.orderId;
		// Query the Order collection with a proper filter object
		const order2 = await Order.findOne({ id_commande: orderId1 });
		console.log("order111", order2);
		return await notifyTeams(payload, order2, context);
		// Continue execution even if finance notification fails
	} catch (error) {
		context.log(`Error in validateProforma: ${error.message}`, error.stack);
		return createSlackResponse(200, {
			response_type: "ephemeral",
			text: `❌ Erreur lors de la validation: ${error.message}`,
		});
	}
}

async function handleProformas(formData, existingMetadata, userId, context) {
	let proformas = existingMetadata.proformas || [];
	const newProformas = await extractProformas(formData, context, 1, userId);

	if (newProformas.valid === false) {
		return { isValid: false };
	}

	if (newProformas.length > 0) {
		const timestampedProformas = newProformas.map((proforma) => ({
			...proforma,
			createdAt: new Date(),
		}));
		proformas = timestampedProformas;
	}

	return { isValid: true, proformas };
}

module.exports = {
	handleProformas,
	handleProformaSubmission,
	handleEditProformaSubmission,
	handleEditProforma,
	handleProformaValidationRequest,
	handleProformaValidationConfirm,
	handleDeleteProformaConfirmation,
	proforma_form,
	validateProforma,
	handleDeleteProforma,
};
