
const { getEquipeOptions, getUnitOptions } = require("../configService");

async function generateOrderForm(
	proformas = [],
	suggestions = {},
	formData = {}
) {
	console.log("** generateOrderForm");
	const today = new Date().toISOString().split("T")[0];

	console.log("Form data reçu:", JSON.stringify(formData, null, 2));
	console.log("Suggestions reçu:", JSON.stringify(suggestions, null, 2));
	console.log("Proformas reçu:", JSON.stringify(proformas, null, 2));
	// Get dynamic options from database
	const EQUIPE_OPTIONS = await getEquipeOptions();
	const UNIT_OPTIONS = await getUnitOptions();

	const blocks = [
		{
			type: "input",
			block_id: "request_title",
			label: { type: "plain_text", text: "📝 Titre de la commande" },
			element: {
				type: "plain_text_input",
				action_id: "input_request_title",

				initial_value: formData.request_title?.input_request_title?.value || "",
			},
		},
		{
			type: "input",
			block_id: "equipe_selection",
			label: { type: "plain_text", text: "Équipe" },
			element: {
				type: "static_select",
				action_id: "select_equipe",
				options: EQUIPE_OPTIONS,
				initial_option: EQUIPE_OPTIONS[0], // Default to first option
			},
		},
		{
			type: "input",
			block_id: "request_date",
			label: { type: "plain_text", text: "Date de la requête" },
			element: {
				type: "datepicker",
				action_id: "input_request_date",
				initial_date:
					formData.request_date?.input_request_date?.selected_date || today,
			},
			hint: {
				type: "plain_text",
				text: "La date doit être aujourd'hui ou une date dans le futur.",
			},
		},
		{
			type: "actions",
			block_id: "add_proforma_1",
			elements: [
				{
					type: "button",
					action_id: "add_proforma_1",
					text: { type: "plain_text", text: "📎 Ajouter des proformas" },
					value: "add_proforma_1",
				},
			],
		},
		{ type: "divider" },
	];

	// Add existing proformas if available
	if (proformas && proformas.length > 0) {
		blocks.push({
			type: "section",
			block_id: "existing_proformas",

			text: {
				type: "mrkdwn",
				text: "*Proformas existants:*",
			},
		});

		// Add each proforma as a section with a "Remove" button
		proformas.forEach((proforma, index) => {
			blocks.push({
				type: "section",
				block_id: `proforma_item_${index}`,

				text: {
					type: "mrkdwn",
					text: `*${proforma.nom || "Proforma"}*\n${
						proforma.montant
							? `Montant: ${proforma.montant} ${proforma.devise || ""}`
							: "Montant non spécifié"
					}`,
				},
				accessory: {
					type: "overflow",
					action_id: `proforma_options_${index}`,
					options: [
						{
							text: { type: "plain_text", text: "Supprimer" },
							value: `remove_proforma_${index}`,
						},
					],
				},
			});
		});

		blocks.push({ type: "divider" });
	}

	let articleIndex = 1;
	const hasArticlesInFormData = Object.keys(formData).some((key) =>
		key.startsWith("quantity_number_")
	);

	if (
		!hasArticlesInFormData &&
		(!suggestions.designations || suggestions.designations.length === 0)
	) {
		// Add a default empty article if none exist
		blocks.push(
			{
				type: "section",
				block_id: `article_group_1`,

				text: { type: "mrkdwn", text: `*Article 1*` },
			},
			{
				type: "input",
				block_id: `designation_1`,
				label: { type: "plain_text", text: "Désignation" },
				element: {
					type: "plain_text_input",
					action_id: `input_designation_1`,
					initial_value: "",
				},
			},
			{
				type: "input",
				block_id: `quantity_number_1`,
				label: { type: "plain_text", text: "Quantité" },
				element: {
					type: "number_input",
					is_decimal_allowed: false,
					action_id: `input_quantity_1`,
					min_value: "0",
					// initial_value: "1",
				},
			},
			{
				type: "input",
				block_id: `quantity_unit_1`,
				label: { type: "plain_text", text: "Unité" },
				element: {
					type: "static_select",
					action_id: `select_unit_1`,
					options: UNIT_OPTIONS,
					initial_option: UNIT_OPTIONS[0],
				},
			}
		);
	} else {
		// Process existing articles from formData
		while (
			formData[`quantity_number_${articleIndex}`] ||
			(articleIndex === 1 &&
				suggestions.designations &&
				suggestions.designations.length > 0)
		) {
			blocks.push(
				{
					type: "section",
					block_id: `article_${articleIndex}`,

					text: { type: "mrkdwn", text: `*Article ${articleIndex}*` },
					accessory:
						articleIndex > 1
							? {
									// Add "Remove" button for articles beyond the first
									type: "button",
									action_id: `remove_article_${articleIndex}`,
									text: { type: "plain_text", text: "Supprimer" },
									value: `remove_article_${articleIndex}`,
									style: "danger",
							  }
							: undefined,
				},
				{
					type: "input",
					block_id: `designation_${articleIndex}`,
					label: { type: "plain_text", text: "Désignation" },
					element: {
						type: "plain_text_input",
						action_id: `input_designation_${articleIndex}`,

						placeholder: {
							type: "plain_text",
							text:
								suggestions.designations?.[articleIndex - 1] ||
								"Entrez la désignation",
						},
						initial_value:
							formData[`designation_${articleIndex}`]?.[
								`input_designation_${articleIndex}`
							]?.value || "",
					},
				},
				{
					type: "input",
					block_id: `quantity_number_${articleIndex}`,
					label: { type: "plain_text", text: "Quantité" },
					element: {
						type: "number_input",
						is_decimal_allowed: false,
						action_id: `input_quantity_${articleIndex}`,
						min_value: "0",
						initial_value:
							formData[`quantity_number_${articleIndex}`]?.[
								`input_quantity_${articleIndex}`
							]?.value || "0",
					},
				}
			);

			// Ensure unit matches an option from UNIT_OPTIONS
			let unitInitialOption;
			const selectedUnitValue =
				formData[`quantity_unit_${articleIndex}`]?.[
					`select_unit_${articleIndex}`
				]?.selected_option?.value;
			if (selectedUnitValue) {
				unitInitialOption =
					UNIT_OPTIONS.find((opt) => opt.value === selectedUnitValue) ||
					UNIT_OPTIONS[0];
			} else {
				unitInitialOption = UNIT_OPTIONS[0];
			}

			blocks.push({
				type: "input",
				block_id: `quantity_unit_${articleIndex}`,
				label: { type: "plain_text", text: "Unité" },
				element: {
					type: "static_select",
					action_id: `select_unit_${articleIndex}`,
					options: UNIT_OPTIONS,
					initial_option: unitInitialOption,
				},
			});

			articleIndex++;
		}
	}

	blocks.push({
		type: "actions",
		block_id: "add_article",
		elements: [
			{
				type: "button",
				action_id: "add_article",
				text: { type: "plain_text", text: "➕ Ajouter un autre article" },
				value: "add_article",
			},
		],
	});

	const view = {
		type: "modal",
		callback_id: "order_form_submission",
		title: { type: "plain_text", text: "Formulaire Commande" },
		submit: { type: "plain_text", text: "Enregistrer" },
		close: { type: "plain_text", text: "Annuler" },
		blocks,
	};

	console.log("Generated view blocks count:", view.blocks.length);
	return view;
}
// Function to open a modal for rejection reason
async function openRejectionReasonModal(payload, orderId) {
	console.log("** openRejectionReasonModal");
	const {
		postSlackMessageWithRetry,
		createSlackResponse,
	} = require("../../Handlers/slackApiUtils");
	try {
		await postSlackMessageWithRetry(
			"https://slack.com/api/views.open",
			{
				trigger_id: payload.trigger_id,
				view: {
					type: "modal",
					callback_id: "rejection_reason_modal",
					private_metadata: JSON.stringify({
						entityId: orderId,
						channel_id: payload.channel.id,
						message_ts: payload.message.ts,
					}),
					title: {
						type: "plain_text",
						text: "Motif de rejet",
						emoji: true,
					},
					submit: {
						type: "plain_text",
						text: "Confirmer le rejet",
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
								text: `Veuillez indiquer la raison du rejet de la commande *${orderId}*`,
							},
						},
						{
							type: "input",
							block_id: "rejection_reason_block",
							element: {
								type: "plain_text_input",
								action_id: "rejection_reason_input",
								multiline: true,
							},
							label: {
								type: "plain_text",
								text: "Motif du rejet",
								emoji: true,
							},
						},
					],
				},
			},
			process.env.SLACK_BOT_TOKEN
		);

		return createSlackResponse(200, "");
	} catch (error) {
		console.error("Error opening rejection modal:", error);
		return createSlackResponse(500, "Error opening rejection modal");
	}
}
// Modify your existing proforma amount input block to include validation
function generateProformaBlocks(index) {
	return [
		{
			type: "actions",
			block_id: `cancel_proforma_${index}`,
			elements: [
				{
					type: "button",
					action_id: `cancel_proforma_${index}`,
					text: { type: "plain_text", text: "❌ Annuler la proforma" },
					value: `cancel_proforma_${index}`,
				},
			],
		},
		{
			type: "input",
			block_id: `proforma_file`,
			optional: true,
			label: {
				type: "plain_text",
				text: `📎 Proforma(s)`,
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
		{
			type: "input",
			block_id: `proforma_amount`,
			label: { type: "plain_text", text: "💰 Montant" },
			element: {
				type: "plain_text_input",
				action_id: `input_proforma_amount`,
				placeholder: { type: "plain_text", text: "Ex: 1000 XOF" },
				focus_on_load: true,
			},
			hint: {
				type: "plain_text",
				text: "Entrez un montant suivi de la devise (XOF, USD, EUR)",
			},
		},
	];
}
async function generateArticleBlocks(index) {
	const UNIT_OPTIONS = await getUnitOptions();

	console.log("** generateArticleBlocks");
	return [
		{ type: "divider", block_id: `divider_${index}` },
		{
			type: "section",
			block_id: `article_${index}`,
			text: { type: "mrkdwn", text: `*Article ${index}*` },
		},
		{
			type: "input",
			block_id: `designation_${index}`,
			label: { type: "plain_text", text: "Désignation" },
			element: {
				type: "plain_text_input",

				action_id: `input_designation_${index}`,
			},
		},
		{
			type: "input",
			block_id: `quantity_number_${index}`,
			label: { type: "plain_text", text: "Quantité" },
			element: {
				type: "number_input",
				is_decimal_allowed: false,
				action_id: `input_quantity_${index}`,

				min_value: "0",
			},
		},
		{
			type: "input",
			block_id: `quantity_unit_${index}`,
			label: { type: "plain_text", text: "Unité" },
			element: {
				type: "static_select",
				action_id: `select_unit_${index}`,
				options: UNIT_OPTIONS,
				initial_option: UNIT_OPTIONS[0], // Default to "Pièce"
			},
		},
		{
			type: "actions",
			block_id: `add_proforma_${index}`,
			elements: [
				{
					type: "button",
					action_id: `remove_article_${index}`,
					text: { type: "plain_text", text: "🗑️ Supprimer l'article" },
					value: `remove_article_${index}`,
					style: "danger", // Make the button red to indicate a destructive action
				},
			],
		},
	];
}
function getOrderBlocks(order) {
	console.log("** getOrderBlocks");
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `📦 Commande: ${order.id_commande}`,
				emoji: true,
			},
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Titre:*\n${order.titre}` },
				{
					type: "mrkdwn",
					text: `*Date:*\n${new Date(order.date).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Demandeur:*\n<@${order.demandeur}>` },
				{ type: "mrkdwn", text: `*Channel:*\n${order.channel}` },
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Équipe:*\n${order.equipe || "Non spécifié"}`,
				},
				{
					type: "mrkdwn",
					text: `*Date requise:*\n${
						new Date(order.date_requete).toLocaleString("fr-FR", {
							weekday: "long",
							year: "numeric",
							month: "long",
							day: "numeric",
						}) || new Date().toISOString()
					}`,
				},
			],
		},
		{ type: "divider" },
		{ type: "section", text: { type: "mrkdwn", text: `*Articles*` } },
		...order.articles.map((article, i) => ({
			type: "section",
			text: {
				type: "mrkdwn",
				text: `  ${i + 1}. Quantité: *${article.quantity} ${
					article.unit
				}* | Désignation: *${article.designation}*`,
			},
		})),
		{ type: "divider" },
	];
}

function getProformaBlocks(order) {
	console.log("** getProformaBlocks");
	const proformas = order.proformas || [];
	return proformas.length > 0
		? proformas
				.map((p) => ({
					type: "section", // Ensure correct type (no typo like "s ection")
					text: {
						type: "mrkdwn",
						text: `*${p.nom}*${
							p.fournisseur ? ` - Fournisseur: *${p.fournisseur}*` : ""
						} - Montant: *${p.montant}* ${p.devise}\n   *URLs:*\n${p.urls
							.map((url, j) => `     ${j + 1}. <${url}|Page ${j + 1}>`)
							.join("\n")}`,
					},
				}))
				.concat([{ type: "divider" }])
		: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "*Proformas - Aucun proforma disponible*",
					},
				},
				{ type: "divider" },
		  ];
}

async function getPaymentBlocks(
	entity,
	paymentData,
	remainingAmount,
	paymentStatus
) {
	console.log("** getPaymentBlocks");
	//console.log("entity111",entity);

	const isOrder = entity && "id_commande" in entity;
	const isPaymentRequest = entity && "id_paiement" in entity;
	// console.log("paymentData1", paymentData);
	console.log("remainingAmount1", remainingAmount);

	console.log("isOrder1", isOrder);
	const currency =
		isOrder && entity.proformas?.[0]?.devise
			? entity.proformas[0].devise
			: entity.devise || "N/A";
	let total;
	if (isOrder) {
		const validatedProformas = entity.proformas.filter((p) => p.validated);
		//  console.log("validated", validatedProformas);

		if (validatedProformas.length > 0) {
			total = validatedProformas[0].montant;
		}
	} else if (isPaymentRequest) {
		total = entity.montant;
	}
	console.log("entity.amountPaid1", entity.amountPaid);

	const totalAmountPaid =
		isOrder && entity.amountPaid !== undefined
			? entity.amountPaid
			: isPaymentRequest && entity.amountPaid !== undefined
			? entity.amountPaid
			: "N/A";
	console.log("totalAmountPaid1", totalAmountPaid);
	console.log("paymentData", paymentData);
	// const amountPaid1 = entity.amountPaid || 0;
	// const remainingAmount1 = totalAmountPaid - amountPaid1;

	const additionalDetails =
		paymentData.mode === "Chèque"
			? [
					{
						type: "mrkdwn",
						text: `*Numéro de chèque:*\n${
							paymentData.details?.cheque_number || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Banque:*\n${paymentData.details?.cheque_bank || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Date du chèque:*\n${
							paymentData.details?.cheque_date || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Ordre:*\n${paymentData.details?.cheque_order || "N/A"}`,
					},
			  ]
			: paymentData.mode === "Virement"
			? [
					{
						type: "mrkdwn",
						text: `*Numéro de virement:*\n${
							paymentData.details?.virement_number || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Banque:*\n${paymentData.details?.virement_bank || "N/A"}`,
					},
					{
						type: "mrkdwn",
						text: `*Date de virement:*\n${
							paymentData.details?.virement_date || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Ordre:*\n${paymentData.details?.virement_order || "N/A"}`,
					},
			  ]
			: paymentData.mode === "Mobile Money"
			? [
					{
						type: "mrkdwn",
						text: `*Numéro de téléphone bénéficiaire:*\n${
							paymentData.details?.mobilemoney_recipient_phone || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Numéro envoyeur:*\n${
							paymentData.details?.mobilemoney_sender_phone || "N/A"
						}`,
					},

					{
						type: "mrkdwn",
						text: `*Date:*\n${paymentData.details?.mobilemoney_date || "N/A"}`,
					},
			  ]
			: paymentData.mode === "Julaya"
			? [
					{
						type: "mrkdwn",
						text: `*Bénéficiaire:*\n${
							paymentData.details?.julaya_recipient || "N/A"
						}`,
					},
					{
						type: "mrkdwn",
						text: `*Numéro de transaction:*\n${
							paymentData.details?.julaya_transaction_number || "N/A"
						}`,
					},

					{
						type: "mrkdwn",
						text: `*Date:*\n${paymentData.details?.julaya_date || "N/A"}`,
					},
			  ]
			: [{ type: "mrkdwn", text: `*Détails:*\n${paymentData.mode || "N/A"}` }];
	// Build proof fields array
	const proofFields = [];
	console.log("paymentData.url", paymentData.url);
	// console.log("paymentData.url.length", paymentData.url.length);
	// Add main payment URL if exists
	if (paymentData.url) {
		if (paymentData.url.length > 0) {
			proofFields.push({
				type: "mrkdwn",
				text: `*Preuve 1:*\n<${paymentData.url}|Voir le justificatif>`,
			});
		}
	}

	// Add additional proofs from paymentData.proofs array
	if (paymentData.proofs && Array.isArray(paymentData.proofs)) {
		paymentData.proofs.forEach((proof, index) => {
			if (proof && proof.trim()) {
				const proofNumber =
					paymentData.url && paymentData.url.length > 0 ? index + 2 : index + 1;
				proofFields.push({
					type: "mrkdwn",
					text: `*Preuve ${proofNumber}:*\n<${proof}|Voir le justificatif>`,
				});
			}
		});
	}
	return [
		{
			type: "header",
			text: {
				type: "plain_text",
				text: `💲 Paiement Enregistré: ${
					entity.id_commande || entity.id_paiement
				}`,
				emoji: true,
			},
		},

		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Titre:*\n${paymentData.title}` },
				{
					type: "mrkdwn",
					text: `*Date:*\n${new Date(paymentData.date).toLocaleString("fr-FR", {
						weekday: "long",
						year: "numeric",
						month: "long",
						day: "numeric",
						hour: "2-digit",
						minute: "2-digit",
						timeZoneName: "short",
					})}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Montant payé:*\n${paymentData.amountPaid} ${currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Reste à payer:*\n${remainingAmount} ${currency}`,
				},
			],
		},
		{
			type: "section",
			fields: [
				{
					type: "mrkdwn",
					text: `*Total montant payé:*\n${totalAmountPaid} ${currency}`,
				},
				{
					type: "mrkdwn",
					text: `*Montant de la demande:*\n${total} ${currency}`,
				},
			],
		},
		{ type: "divider" },
		{
			type: "section",
			fields: [
				{ type: "mrkdwn", text: `*Mode de paiement:*\n${paymentData.mode}` },
				{ type: "mrkdwn", text: `*Statut de paiement:*\n${paymentStatus}` },
			],
		},
		{
			type: "section",
			fields: additionalDetails.slice(0, 2), // First 2 fields
		},
		...(additionalDetails.length > 2
			? [
					{
						type: "section",
						fields: additionalDetails.slice(2), // Remaining fields
					},
			  ]
			: []),
		{ type: "divider" },
		{ type: "section", text: { type: "mrkdwn", text: `*Justificatif(s)*` } },

		...(proofFields.length > 0
			? [
					{
						type: "section",
						fields: proofFields.slice(0, 2), // First 2 proof fields
					},
					...(proofFields.length > 2
						? [
								{
									type: "section",
									fields: proofFields.slice(2), // Remaining proof fields
								},
						  ]
						: []),
			  ]
			: []),
	].filter(Boolean);
}

module.exports = {
	generateOrderForm,
	generateProformaBlocks,
	generateArticleBlocks,
	getOrderBlocks,
	getProformaBlocks,
	getPaymentBlocks,
	openRejectionReasonModal,
};
