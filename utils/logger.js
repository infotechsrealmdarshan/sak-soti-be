/**
 * Simple logger utility for consistent logging across the application
 */

const logger = {
    enabled: false, // 🔥 turn this ON/OFF to show or hide all logs

    /**
     * Log informational messages
     * @param  {...any} args - Arguments to log
     */
    log: (...args) => {
        if (!logger.enabled) return;
        console.log(...args);
    },

    /**
     * Log error messages
     * @param  {...any} args - Arguments to log
     */
    error: (...args) => {
        if (!logger.enabled) return;
        console.error(...args);
    },

    /**
     * Log warning messages
     * @param  {...any} args - Arguments to log
     */
    warn: (...args) => {
        if (!logger.enabled) return;
        console.warn(...args);
    },

    /**
     * Log informational messages
     * @param  {...any} args - Arguments to log
     */
    info: (...args) => {
        if (!logger.enabled) return;
        console.info(...args);
    },

    /**
     * Log debug messages
     * @param  {...any} args - Arguments to log
     */
    debug: (...args) => {
        if (!logger.enabled) return;
        console.debug(...args);
    },
};

export default logger;
