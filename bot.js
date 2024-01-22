import { } from 'dotenv/config'; // Load environment variables from a .env file
import { Telegraf, Markup } from 'telegraf'; // Telegram bot framework
import { message } from 'telegraf/filters'
import { GoogleSpreadsheet } from 'google-spreadsheet'; // Google Sheets API wrapper
import { JWT } from 'google-auth-library'; // Google Auth Library for authentication
import { CronJob } from 'cron'; // Cron job scheduler for scheduling tasks

console.log('script started');

if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_SHEETS_ID || !process.env.BOT_TOKEN || !process.env.CHAT_ID) {
    console.error('Missing one or more environment variables');
    process.exit(1);
}

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY.split(String.raw`\n`).join('\n'), // Parse and format private key
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets', // Google Sheets API scope
    ],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEETS_ID, serviceAccountAuth);

await doc.loadInfo();

const mainSheet = doc.sheetsByTitle['main'];
const schedule = doc.sheetsByTitle['schedule'];
const sheetTech = doc.sheetsByTitle['technical'];

let chatId = process.env.CHAT_ID;
const bot = new Telegraf(process.env.BOT_TOKEN);

let messageID;

// Fetch data from Google Sheets
async function fetchData() {
    // Load cells from each sheet
    await mainSheet.loadCells('A1:C20');
    await schedule.loadCells('A2:H15');
    await sheetTech.loadCells('B1:B10');
}

// Get the schedule for a specific weekday
function getWeekdaySchedule(weekDay) {
    const weekNum = sheetTech.getCellByA1('B1').value;
    let result = [];
    for (let i = 0; i < 7; i++) {
        let temp = schedule.getCell(weekDay + ((weekNum % 2) * 5), i + 1).value;
        result[i] = temp ?? null;
    }
    return result;
}

// Get the final message text for a list of subjects
function getFinalMessageText(subjects) {
    const countOfSubjects = sheetTech.getCellByA1('B3').value;

    let finalMessage = '<b>Дз на завтра:</b> \n';
    for (let i = 0; i < subjects.length; i++) {
        if (subjects[i] != null) {
            for (let j = 0; j < countOfSubjects; j++) {
                if (subjects[i] == mainSheet.getCell(j + 1, 0).value) {
                    finalMessage += "<b>" + subjects[i] + "</b>: <i>" + mainSheet.getCell(j + 1, 1).value + '</i> \n';
                    break;
                }
            }
        }
    }
    return finalMessage;
}

// Start the bot
async function startBot() {
    await fetchData()

    const countOfSubjects = sheetTech.getCellByA1('B3').value;

    bot.on(message('text'), async (ctx) => {
        const msg = ctx.update.message.text;

        if (msg.toLowerCase() === '/hw@timetableip21bot' || msg === '/homework' || msg === '/hw' || msg === 'дз' || msg === 'зд' || msg === 'hw') {
            let buttons = [];
            for (let i = 0; i < countOfSubjects; i++) {
                buttons[i] = Markup.button.callback(mainSheet.getCell(i + 1, 2).value, mainSheet.getCell(i + 1, 2).value)
            }

            const keyboard = Markup.inlineKeyboard(buttons, { columns: countOfSubjects / 4 })

            let message_id = (await ctx.replyWithMarkdownV2('Вибери предмет:', keyboard)).message_id;

            idleTimers.set(message_id, setTimeout(async () => {
                ctx.telegram.deleteMessage(chatId, message_id);
                ctx.telegram.deleteMessage(chatId, ctx.update.message.message_id);
            }, 30000));

        }
        if (msg.toLowerCase() === 'update') {
            await fetchData();
        }
    });


    let idleTimers = new Map();
    bot.action(/.+/, async (ctx) => {
        if (ctx.update.callback_query.message.chat.id != chatId) return;

        let message_id = ctx.update.callback_query.message.message_id;
        let subjects = [];

        for (var i = 0; i < countOfSubjects; i++) {
            subjects[i] = mainSheet.getCell(i + 1, 2).value;
        }

        const text = ctx.update.callback_query.message.text;
        let finalMessage = "<b>" + mainSheet.getCell(subjects.indexOf(ctx.match[0]) + 1, 0).value + "</b>: " + "<i>" + mainSheet.getCell(subjects.indexOf(ctx.match[0]) + 1, 1).value + "</i>";

        if (idleTimers.has(message_id)) clearTimeout(idleTimers.get(message_id));


        idleTimers.set(message_id, setTimeout(async () => {
            await ctx.telegram.editMessageText(chatId, message_id, undefined, text + "\n" + finalMessage, { parse_mode: "HTML" });
        }, 30000));

        if (text.split('\n').length >= 5) {
            await ctx.telegram.editMessageText(chatId, message_id, undefined, text + "\n" + finalMessage, { parse_mode: "HTML" });
            clearTimeout(idleTimers.get(message_id));
        } else {
            await ctx.telegram.editMessageText(chatId, message_id, undefined, text + "\n" + finalMessage, { reply_markup: ctx.update.callback_query.message.reply_markup, parse_mode: "HTML" });
        }
    });

    console.log('Starting bot');

    bot.launch();

    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// Send homework
async function sendHomework() {
    await fetchData();
    const weekDay = new Date().getDay();
    messageID = messageID || sheetTech.getCellByA1("B4").value;

    if (messageID) {
        try {
            await bot.telegram.unpinChatMessage(chatId, messageID);
        } catch (error) {
            console.error(error);
        }
    }

    let subjects = getWeekdaySchedule(weekDay + 1);

    messageID = (await bot.telegram.sendMessage(chatId, getFinalMessageText(subjects), { parse_mode: "HTML" })).message_id;
    await bot.telegram.pinChatMessage(chatId, messageID);

    sheetTech.getCellByA1("B4").value = messageID;
    await sheetTech.saveUpdatedCells();
}

// Delete old assignments
async function deleteOldAssignments() {
    await fetchData();
    const weekDay = new Date().getDay();
    let subjects = getWeekdaySchedule(weekDay);
    const countOfSubjects = sheetTech.getCellByA1('B3').value;

    for (let i = 0; i < subjects.length; i++) {
        if (subjects[i] != null) {
            for (let j = 0; j < countOfSubjects; j++) {
                if (subjects[i] == mainSheet.getCell(j + 1, 0).value) {
                    mainSheet.getCell(j + 1, 1).value = 'ДЗ не записали';
                    break;
                }
            }
        }
    }
    await mainSheet.saveUpdatedCells();
}

// Start the bot and schedule tasks
async function start() {
    await startBot();
    new CronJob('00 15 * * 1-5', sendHomework, null, true);
    new CronJob('40 8 * * 1-5', deleteOldAssignments, null, true);
}

// Run the script
start().catch(console.error);