const axios = require("axios").default;
const tough = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const TelegramBot = require("node-telegram-bot-api");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
let bot = null;

if (require.main === module) {
  bot = new TelegramBot(TELEGRAM_TOKEN);
  bot.setWebHook('');
}

const BASE_URL = "https://roadpolice.am";
const LOGIN_URL = `${BASE_URL}/hy/hqb-sw/login`;
const NEAREST_URL = `${BASE_URL}/hy/hqb-nearest-day`;
const PROFILE_URL = `${BASE_URL}/hy/hqb-profile`;

const accounts = [
    {
        psn: process.env.PSN,
        phone_number: process.env.PHONE_NUMBER,
        country: "374",
        login_type: "hqb"
    },
    {
        psn: process.env.PSN_2,
        phone_number: process.env.PHONE_NUMBER_2,
        country: "374",
        login_type: "hqb"
    },
    {
        psn: process.env.PSN_3,
        phone_number: process.env.PHONE_NUMBER_3,
        country: "374",
        login_type: "hqb"
    },
    {
        psn: process.env.PSN_4,
        phone_number: process.env.PHONE_NUMBER_4,
        country: "374",
        login_type: "hqb"
    }
];

let currentAccountIndex = 0;
let accountSessions = {}; 
let accountLimits = {};

const CHECK_INTERVAL = (parseInt(process.env.CHECK_INTERVAL) || 10) * 3 * 1000; // 30 seconds
const RETRY_DELAY = 3 * 60 * 1000; // 3 minutes for daily limit errors
const ACCOUNT_SWITCH_DELAY = 30 * 1000; // 30 seconds delay when switching accounts

let paused = false;
let errorNotificationSent = false;
let checkTimer = null;
let accountTimers = {}; // Store timers for each account

// Account management functions
function getCurrentAccount() {
    return accounts[currentAccountIndex];
}

function getCurrentAccountId() {
    return `${getCurrentAccount().psn}_${getCurrentAccount().phone_number}`;
}

function switchToNextAccount() {
    const previousIndex = currentAccountIndex;
    currentAccountIndex = (currentAccountIndex + 1) % accounts.length;
    
    console.log(`🔄 Switching from account ${previousIndex} to account ${currentAccountIndex}`);
    console.log(`📱 New account: ${getCurrentAccount().phone_number}`);
    
    // Clear session for the new account to force re-login
    const accountId = getCurrentAccountId();
    if (accountSessions[accountId]) {
        delete accountSessions[accountId];
    }
}

function markAccountAsLimited(accountIndex) {
    const account = accounts[accountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    accountLimits[accountId] = Date.now();
    console.log(`⚠️ Account ${accountIndex} (${account.phone_number}) marked as limited`);
}

function isAccountLimited(accountIndex) {
    const account = accounts[accountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    const limitTime = accountLimits[accountId];
    
    if (!limitTime) return false;
    
    // Reset limit after 24 hours
    const hoursSinceLimit = (Date.now() - limitTime) / (1000 * 60 * 60);
    if (hoursSinceLimit >= 24) {
        delete accountLimits[accountId];
        console.log(`🔄 Account ${accountIndex} limit reset after 24 hours`);
        return false;
    }
    
    return true;
}

function getAvailableAccountIndex() {
    // First try current account if not limited
    if (!isAccountLimited(currentAccountIndex)) {
        return currentAccountIndex;
    }
    
    // Find next available account
    for (let i = 0; i < accounts.length; i++) {
        const index = (currentAccountIndex + i) % accounts.length;
        if (!isAccountLimited(index)) {
            return index;
        }
    }
    
    // All accounts are limited, return current
    return currentAccountIndex;
}

// Function to check if error is daily limit error
function isDailyLimitError(error) {
    const errorData = error.response?.data || error;
    return errorData.status === 'ERROR' && errorData.error?.includes('սահմանաչափը սպառված է');
}

// Function to check if error is temporary service unavailability
function isTemporaryServiceError(error) {
    const errorData = error.response?.data || error;

    if (errorData.error === 'Հերթի ծառայությունը ժամանակավորապես անհասանելի է։ Խնդրում ենք փորձել ավելի ուշ') {
        return true;
    }
    if (errorData.message === 'Server Error') {
        return true;
    }

    const errorString = JSON.stringify(errorData).toLowerCase();
    if (errorString.includes('temporary') || errorString.includes('unavailable') ||
        errorString.includes('service') || errorString.includes('server')) {
        return true;
    }

    return false;
}

function parseDate(d) {
    const [day, month, year] = d.split("-").map(Number);
    return new Date(year, month - 1, day);
}

function formatDateForAPI(date) {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    return `${day}-${month}-${year}`;
}

async function login(accountIndex = null) {
    const targetAccountIndex = accountIndex !== null ? accountIndex : currentAccountIndex;
    const account = accounts[targetAccountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    
    try {
        // Create a new jar for this account if it doesn't exist
        if (!accountSessions[accountId]) {
            accountSessions[accountId] = {
                jar: new tough.CookieJar(),
                client: null,
                isLoggedIn: false,
                xsrfToken: null
            };
        }
        
        const session = accountSessions[accountId];
        session.client = wrapper(axios.create({ jar: session.jar, withCredentials: true }));
        
        await session.jar.removeAllCookies();
        await session.client.get(`${BASE_URL}/hy/hqb`);

        const cookies = await session.jar.getCookies(BASE_URL);
        const xsrfCookie = cookies.find(c => c.key === "XSRF-TOKEN");

        if (!xsrfCookie) throw new Error("Missing XSRF token cookie");

        session.xsrfToken = decodeURIComponent(xsrfCookie.value);
        console.log(`XSRF Token for account ${targetAccountIndex}:`, session.xsrfToken);

        const payload = new URLSearchParams(account);

        const res = await session.client.post(LOGIN_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": session.xsrfToken,
                "X-Requested-With": "XMLHttpRequest",
            }
        });

        if (res.data.status !== "OK") {
            throw new Error("Login failed: " + JSON.stringify(res.data));
        }

        session.isLoggedIn = true;
        console.log(`✅ Successfully logged in with account ${targetAccountIndex} (${account.phone_number})`);
        return session.xsrfToken;
    } catch (error) {
        if (accountSessions[accountId]) {
            accountSessions[accountId].isLoggedIn = false;
            accountSessions[accountId].xsrfToken = null;
        }
        throw error;
    }
}

async function checkSessionValidity(accountIndex = null) {
    const targetAccountIndex = accountIndex !== null ? accountIndex : currentAccountIndex;
    const account = accounts[targetAccountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    const session = accountSessions[accountId];
    
    if (!session || !session.client) {
        return false;
    }
    
    try {
        const res = await session.client.get(PROFILE_URL, {
            headers: { "X-Requested-With": "XMLHttpRequest" }
        });
        return res.status === 200;
    } catch {
        return false;
    }
}

async function ensureAuthenticated(accountIndex = null) {
    const targetAccountIndex = accountIndex !== null ? accountIndex : currentAccountIndex;
    const account = accounts[targetAccountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    const session = accountSessions[accountId];
    
    if (!session || !session.isLoggedIn) {
        console.log(`Not logged in for account ${targetAccountIndex}, attempting login...`);
        return await login(targetAccountIndex);
    }
    
    try {
        const isValid = await checkSessionValidity(targetAccountIndex);
        if (!isValid) {
            console.log(`Session expired for account ${targetAccountIndex}, re-logging in...`);
            return await login(targetAccountIndex);
        }
        return session.xsrfToken;
    } catch {
        console.log(`Session check failed for account ${targetAccountIndex}, re-logging in...`);
        return await login(targetAccountIndex);
    }
}

async function checkNearestDay(accountIndex = null) {
    const targetAccountIndex = accountIndex !== null ? accountIndex : currentAccountIndex;
    const token = await ensureAuthenticated(targetAccountIndex);
    const account = accounts[targetAccountIndex];
    const accountId = `${account.psn}_${account.phone_number}`;
    const session = accountSessions[accountId];

    const payload = new URLSearchParams();
    payload.append('branchId', '39');
    payload.append('serviceId', '300692');
    payload.append('date', '01-11-2025');

    console.log(`📅 Requesting nearest day with date: 01-11-2025 (Account ${targetAccountIndex}: ${account.phone_number})`);

    try {
        const res = await session.client.post(NEAREST_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": token,
                "X-Requested-With": "XMLHttpRequest",
            }
        });
        return res.data;
    } catch (error) {
        console.error(`❌ Error in checkNearestDay for account ${targetAccountIndex}:`, error.response?.data || error.message);
        throw error;
    }
}

async function performCheck(accountIndex = null) {
    if (paused) {
        console.log("⏸️ Checks are paused, skipping...");
        return { status: 'paused', message: 'Checks paused' };
    }

    // Determine which account to use
    const targetAccountIndex = accountIndex !== null ? accountIndex : getAvailableAccountIndex();
    
    // If current account is limited, switch to next available
    if (targetAccountIndex !== currentAccountIndex) {
        currentAccountIndex = targetAccountIndex;
        console.log(`🔄 Using account ${currentAccountIndex} (${getCurrentAccount().phone_number})`);
    }

    try {
        console.log(`🔍 Starting check at ${new Date().toISOString()} with account ${currentAccountIndex}`);

        const result = await checkNearestDay(currentAccountIndex);
        console.log("📅 Result:", JSON.stringify(result, null, 2));

        // Reset error notification flag if request was successful
        errorNotificationSent = false;

        // 🔹 Handle daily limit
        if (result.status === "ERROR" && result.error?.includes('սահմանաչափը սպառված է')) {
            console.log(`⚠️ Daily limit reached for account ${currentAccountIndex}, marking as limited`);
            
            // Mark current account as limited
            markAccountAsLimited(currentAccountIndex);
            
            // Check if we have other available accounts
            const nextAvailableIndex = getAvailableAccountIndex();
            
            if (nextAvailableIndex !== currentAccountIndex) {
                console.log(`🔄 Switching to account ${nextAvailableIndex} after limit reached`);
                currentAccountIndex = nextAvailableIndex;
                
                // Send notification about account switch
                if (bot) {
                    try {
                        const currentAccount = getCurrentAccount();
                        await bot.sendMessage(CHAT_ID, `⚠️ Account ${currentAccountIndex} hit daily limit. Switched to account ${nextAvailableIndex} (${currentAccount.phone_number}).`);
                    } catch (err) {
                        console.error("Failed to send Telegram message:", err.message);
                    }
                }
                
                // Continue with next account after a short delay
                setTimeout(() => {
                    performCheck();
                }, ACCOUNT_SWITCH_DELAY);
                
                return { status: 'account_switched', message: 'Switched to next available account' };
            } else {
                // All accounts are limited
                console.log("⚠️ All accounts have reached daily limit, pausing for 3 minutes");
                
                // Send notification only if not already sent
                if (!errorNotificationSent && bot) {
                    try {
                        await bot.sendMessage(CHAT_ID, "⚠️ Բոլոր հաշիվները հասել են օրվա սահմանաչափին։ Ստուգումները դադարեցվեցին 3 րոպեով։");
                        errorNotificationSent = true;
                    } catch (err) {
                        console.error("Failed to send Telegram message:", err.message);
                    }
                }
                
                // Auto-resume after 3 minutes
                paused = true;
                setTimeout(() => {
                    console.log("🔄 Resuming checks after 3 minute pause");
                    paused = false;
                    errorNotificationSent = false;
                    performCheck();
                }, RETRY_DELAY);
                
                return { status: 'all_accounts_limited', message: 'All accounts limited, bot paused' };
            }
        }

        if (result.status === "OK" && result.data?.day) {
            const nearest = result.data.day;
            const slots = result.data.slots || [];
            console.log("🚨 Nearest date found:", nearest);
            console.log("📋 Available slots:", slots.length);

            const targetDate = new Date(2025, 10, 1);
            const nearestDate = parseDate(nearest);

            if (nearestDate <= targetDate && bot) {
                const message = `🚨 Nearest date available: ${nearest}\nAvailable slots: ${slots.length}\nFirst slot: ${slots[0]?.value || 'N/A'}`;
                try {
                    await bot.sendMessage(CHAT_ID, message);
                } catch (err) {
                    console.error("Failed to send Telegram message:", err.message);
                }
                return { status: 'success', message: 'Notification sent', date: nearest, slots: slots };
            } else {
                console.log("No suitable date found. Nearest:", nearest);
                return { status: 'no_change', message: 'No suitable date', date: nearest };
            }
        }

        return { status: 'no_data', message: 'No date data received', data: result };

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);

        // Handle daily limit error from exception
        if (isDailyLimitError(err)) {
            console.log(`⚠️ Daily limit reached for account ${currentAccountIndex}, marking as limited`);
            
            // Mark current account as limited
            markAccountAsLimited(currentAccountIndex);
            
            // Check if we have other available accounts
            const nextAvailableIndex = getAvailableAccountIndex();
            
            if (nextAvailableIndex !== currentAccountIndex) {
                console.log(`🔄 Switching to account ${nextAvailableIndex} after limit error`);
                currentAccountIndex = nextAvailableIndex;
                
                // Send notification about account switch
                if (bot) {
                    try {
                        const currentAccount = getCurrentAccount();
                        await bot.sendMessage(CHAT_ID, `⚠️ Account ${currentAccountIndex} hit daily limit. Switched to account ${nextAvailableIndex} (${currentAccount.phone_number}).`);
                    } catch (telegramErr) {
                        console.error("Failed to send Telegram message:", telegramErr.message);
                    }
                }
                
                // Continue with next account after a short delay
                setTimeout(() => {
                    performCheck();
                }, ACCOUNT_SWITCH_DELAY);
                
                return { status: 'account_switched', message: 'Switched to next available account' };
            } else {
                // All accounts are limited
                console.log("⚠️ All accounts have reached daily limit, pausing for 3 minutes");
                
                // Send notification only if not already sent
                if (!errorNotificationSent && bot) {
                    try {
                        await bot.sendMessage(CHAT_ID, "⚠️ Բոլոր հաշիվները հասել են օրվա սահմանաչափին։ Ստուգումները դադարեցվեցին 3 րոպեով։");
                        errorNotificationSent = true;
                    } catch (telegramErr) {
                        console.error("Failed to send Telegram message:", telegramErr.message);
                    }
                }
                
                // Auto-resume after 3 minutes
                paused = true;
                setTimeout(() => {
                    console.log("🔄 Resuming checks after 3 minute pause");
                    paused = false;
                    errorNotificationSent = false;
                    performCheck();
                }, RETRY_DELAY);
                
                return { status: 'all_accounts_limited', message: 'All accounts limited, bot paused' };
            }
        }

        if (isTemporaryServiceError(err)) {
            console.log("🔄 Temporary service error, will retry in 3 minutes");
            
            // Schedule a retry after 3 minutes
            setTimeout(() => {
                console.log("🔄 Retrying after temporary service error");
                performCheck();
            }, RETRY_DELAY);
            
            return { status: 'temporary_error', message: 'Temporary service unavailability' };
        }

        // Clear session for current account on error
        const account = getCurrentAccount();
        const accountId = `${account.psn}_${account.phone_number}`;
        if (accountSessions[accountId]) {
            accountSessions[accountId].isLoggedIn = false;
            accountSessions[accountId].xsrfToken = null;
        }
        
        return { status: 'error', message: err.response?.data || err.message };
    }
}

async function checkNearestDayAlternative(accountIndex = null) {
    const targetAccountIndex = accountIndex !== null ? accountIndex : currentAccountIndex;
    try {
        const token = await ensureAuthenticated(targetAccountIndex);
        const account = accounts[targetAccountIndex];
        const accountId = `${account.psn}_${account.phone_number}`;
        const session = accountSessions[accountId];
        
        const payload = new URLSearchParams();
        payload.append('branchId', '39');
        payload.append('serviceId', '300692');
        payload.append('date', '2025-09-01');

        console.log(`📅 Alternative: YYYY-MM-DD format (Account ${targetAccountIndex})`);

        const res = await session.client.post(NEAREST_URL, payload.toString(), {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-XSRF-TOKEN": token,
                "X-Requested-With": "XMLHttpRequest",
            }
        });
        return res.data;
    } catch (error) {
        console.log(`❌ Alternative failed for account ${targetAccountIndex}:`, error.response?.data || error.message);
        return null;
    }
}

// Function to start interval-based checking for each account
function startAccountIntervals() {
    console.log(`🚀 Starting interval-based checks for ${accounts.length} accounts`);
    
    // Clear any existing timers
    Object.values(accountTimers).forEach(timer => clearInterval(timer));
    accountTimers = {};
    
    // Start a timer for each account with staggered intervals
    accounts.forEach((account, index) => {
        const accountId = `${account.psn}_${account.phone_number}`;
        const intervalDelay = index * (CHECK_INTERVAL / accounts.length); // Stagger the start times
        
        console.log(`⏰ Starting timer for account ${index} (${account.phone_number}) with ${intervalDelay/1000}s delay`);
        
        // Initial delay to stagger account checks
        setTimeout(() => {
            // Perform initial check
            performCheck(index);
            
            // Set up recurring interval
            accountTimers[accountId] = setInterval(() => {
                // Only check if this account is not limited
                if (!isAccountLimited(index)) {
                    performCheck(index);
                } else {
                    console.log(`⏸️ Skipping check for limited account ${index}`);
                }
            }, CHECK_INTERVAL);
        }, intervalDelay);
    });
}

// HTTP endpoint for manual triggering
module.exports = async (req, res) => {
    try {
        const result = await performCheck();
        return res.status(result.status === 'error' ? 500 : 200).json(result);
    } catch (err) {
        if (isTemporaryServiceError(err)) {
            return res.status(200).json({ status: 'temporary_error', message: 'Temporary service unavailability' });
        }
        return res.status(500).json({ status: 'error', message: 'Unexpected error: ' + err.message });
    }
};

// Start scheduled checks
if (require.main === module) {
    console.log("🚀 Starting Road Police Checker with multi-account support");
    console.log(`📱 Configured accounts: ${accounts.length}`);
    console.log(`⏰ Check interval: ${CHECK_INTERVAL/1000} seconds per account`);
    
    // Initialize and start checking with interval-based scheduling
    startAccountIntervals();

    // Cleanup on exit
    process.on('SIGTERM', () => {
        console.log("🛑 Shutting down...");
        Object.values(accountTimers).forEach(timer => clearInterval(timer));
        if (checkTimer) clearInterval(checkTimer);
        process.exit(0);
    });
    
    process.on('SIGINT', () => {
        console.log("🛑 Shutting down...");
        Object.values(accountTimers).forEach(timer => clearInterval(timer));
        if (checkTimer) clearInterval(checkTimer);
        process.exit(0);
    });
}