/**
 * Simple logger utility for consistent logging across the application
 */

const logger = {
    /**
     * Log informational messages
     * @param  {...any} args - Arguments to log
     */
    log: (...args) => {
        console.log(...args);
    },

    /**
     * Log error messages
     * @param  {...any} args - Arguments to log
     */
    error: (...args) => {
        console.error(...args);
    },

    /**
     * Log warning messages
     * @param  {...any} args - Arguments to log
     */
    warn: (...args) => {
        console.warn(...args);
    },

    /**
     * Log informational messages
     * @param  {...any} args - Arguments to log
     */
    info: (...args) => {
        console.info(...args);
    },

    /**
     * Log debug messages
     * @param  {...any} args - Arguments to log
     */
    debug: (...args) => {
        console.debug(...args);
    },
};

export default logger;
