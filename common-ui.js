/**
 * Common UI utilities and components for test results pages
 * Shared between crashes.html, issues.html, and failures.html
 */

// ===== HTML Utility Functions =====

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttr(text) {
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNumber(num) {
    return num.toLocaleString();
}

// ===== Search Box Management =====

/**
 * Initialize search box with clear button and event handlers
 * @param {Object} options - Configuration options
 * @param {string} options.searchBoxId - ID of search input element
 * @param {string} options.searchClearId - ID of clear button element
 * @param {Function} options.onSearch - Callback when search changes (after debounce)
 * @param {Function} options.updateUrlHash - Function to update URL hash with current state
 * @param {number} [options.debounceMs=300] - Debounce delay in milliseconds
 * @returns {Object} - Object with methods to control the search box
 */
function initSearchBox(options) {
    const {
        searchBoxId,
        searchClearId,
        onSearch,
        updateUrlHash,
        debounceMs = 300
    } = options;

    const searchBox = document.getElementById(searchBoxId);
    const searchClear = document.getElementById(searchClearId);
    let filterTimeout;
    let isNavigating = false;

    function updateClearButton() {
        searchClear.style.display = searchBox.value ? 'flex' : 'none';
    }

    searchBox.addEventListener('input', function() {
        updateClearButton();

        // Clear previous timeout
        clearTimeout(filterTimeout);

        // Debounce filtering and hash update
        filterTimeout = setTimeout(() => {
            if (!isNavigating) {
                updateUrlHash();
            }
            onSearch();
        }, debounceMs);
    });

    searchClear.addEventListener('click', function() {
        searchBox.value = '';
        updateClearButton();
        clearTimeout(filterTimeout);
        updateUrlHash();
        onSearch();
        searchBox.focus();
    });

    // Initial state
    updateClearButton();

    return {
        getValue: () => searchBox.value,
        setValue: (value) => {
            searchBox.value = value;
            updateClearButton();
        },
        setNavigating: (value) => { isNavigating = value; },
        updateClearButton
    };
}

// ===== Date Selector Management =====

/**
 * Populate date selector from index.json
 * @param {Object} options - Configuration options
 * @param {string} options.selectId - ID of select element
 * @param {string} options.statusTextId - ID of status text element
 * @param {Function} options.fetchData - Function to fetch data files
 * @returns {Promise<boolean>} - True if successful, false otherwise
 */
async function populateDateSelector(options) {
    const { selectId, statusTextId, fetchData } = options;
    const select = document.getElementById(selectId);

    try {
        const response = await fetchData('index.json');
        if (response.ok) {
            const index = await response.json();

            // Clear all existing options
            select.innerHTML = '';

            // Add all available dates
            if (index.dates && index.dates.length > 0) {
                index.dates.forEach((date, dateIndex) => {
                    const option = document.createElement('option');
                    option.value = date;
                    option.text = date;
                    option.selected = dateIndex === 0; // Select first (most recent) date
                    select.appendChild(option);
                });

                return true;
            } else {
                throw new Error('No data available');
            }
        } else {
            throw new Error('No data available. Please run: node fetch-xpcshell-data.js');
        }
    } catch (e) {
        console.error('Could not load date index:', e);
        const contentElement = document.getElementById('content') || document.getElementById('tree-container');
        if (contentElement) {
            contentElement.innerHTML = `<div class="no-data">${e.message}</div>`;
        }
        if (statusTextId) {
            document.getElementById(statusTextId).textContent = 'Error loading data';
        }
        return false;
    }
}

/**
 * Initialize date selector with change handler
 * @param {Object} options - Configuration options
 * @param {string} options.selectId - ID of select element
 * @param {Function} options.onChange - Callback when date changes
 * @param {Function} options.updateUrlHash - Function to update URL hash
 */
function initDateSelector(options) {
    const { selectId, onChange, updateUrlHash } = options;
    const select = document.getElementById(selectId);

    select.addEventListener('change', function() {
        if (updateUrlHash) {
            updateUrlHash();
        }
        onChange();
    });

    return {
        getValue: () => select.value,
        setValue: (value) => { select.value = value; },
        getElement: () => select,
        hasOption: (value) => select.querySelector(`option[value="${value}"]`) !== null
    };
}

// ===== Historical Mode Toggle =====

/**
 * Initialize historical mode toggle button
 * @param {Object} options - Configuration options
 * @param {string} options.buttonId - ID of toggle button element
 * @param {string} options.selectId - ID of date selector element
 * @param {string} options.statusTextId - ID of status text element
 * @param {Function} options.fetchData - Function to fetch data files
 * @param {Function} options.onToggle - Callback when mode toggles (receives isHistorical boolean)
 * @param {Function} options.updateUrlHash - Function to update URL hash
 * @param {string} [options.historicalDataFile='xpcshell-issues-with-taskids.json'] - Historical data filename
 * @param {string} [options.singleDayText='Show Single Day'] - Text for button in historical mode
 * @param {string} [options.historicalText='Show Last 21 Days'] - Text for button in single day mode
 * @returns {Object} - Object with methods to control historical mode
 */
function initHistoricalToggle(options) {
    const {
        buttonId,
        selectId,
        statusTextId,
        fetchData,
        onToggle,
        updateUrlHash,
        historicalDataFile = 'xpcshell-issues-with-taskids.json',
        singleDayText = 'Show Single Day',
        historicalText = 'Show Last 21 Days'
    } = options;

    const button = document.getElementById(buttonId);
    const dateSelect = document.getElementById(selectId);
    const statusText = document.getElementById(statusTextId);
    const dateLabel = dateSelect.previousElementSibling;

    let isHistoricalMode = false;
    let historicalData = null;

    async function toggle() {
        if (isHistoricalMode) {
            // Switch back to single day view
            isHistoricalMode = false;
            button.textContent = historicalText;
            button.classList.remove('active');
            dateSelect.disabled = false;

            // Show date selector and label
            dateSelect.style.display = '';
            if (dateLabel && dateLabel.tagName === 'LABEL') {
                dateLabel.style.display = '';
            }

            updateUrlHash();
            await onToggle(false, null);
        } else {
            // Switch to historical view
            try {
                statusText.textContent = 'Loading historical data...';
                button.disabled = true;

                const response = await fetchData(historicalDataFile);
                if (!response.ok) {
                    throw new Error('Historical data not available');
                }

                historicalData = await response.json();
                isHistoricalMode = true;
                button.textContent = singleDayText;
                button.classList.add('active');
                dateSelect.disabled = true;

                // Hide date selector and label
                dateSelect.style.display = 'none';
                if (dateLabel && dateLabel.tagName === 'LABEL') {
                    dateLabel.style.display = 'none';
                }

                // Update status text
                if (historicalData.metadata) {
                    const days = historicalData.metadata.days || 21;
                    const startDate = historicalData.metadata.startDate;
                    const endDate = historicalData.metadata.endDate;
                    statusText.textContent = `${days} days (${startDate} to ${endDate})`;
                }

                updateUrlHash();
                await onToggle(true, historicalData);
            } catch (error) {
                console.error('Error loading historical data:', error);
                const contentElement = document.getElementById('content') || document.getElementById('tree-container');
                if (contentElement) {
                    contentElement.innerHTML = `<div class="no-data">${error.message}</div>`;
                }
                statusText.textContent = 'Error loading data';
            } finally {
                button.disabled = false;
            }
        }
    }

    button.addEventListener('click', toggle);

    return {
        toggle,
        isHistoricalMode: () => isHistoricalMode,
        getHistoricalData: () => historicalData,
        setMode: async (historical) => {
            if (historical !== isHistoricalMode) {
                await toggle();
            }
        }
    };
}

// ===== URL Hash Management =====

/**
 * Create URL hash manager
 * @param {Object} options - Configuration options
 * @param {Function} options.getState - Function that returns state object to encode in hash
 * @param {Function} options.onHashChange - Callback when hash changes (receives parsed params)
 * @returns {Object} - Object with methods to manage URL hash
 */
function initUrlHashManager(options) {
    const { getState, onHashChange } = options;

    function updateHash() {
        const state = getState();
        const params = new URLSearchParams();

        for (const [key, value] of Object.entries(state)) {
            if (value) {
                params.set(key, value);
            }
        }

        const hash = params.toString();
        if (hash) {
            window.history.replaceState(null, '', '#' + hash);
        } else {
            window.history.replaceState(null, '', window.location.pathname);
        }
    }

    function loadFromHash() {
        const hash = window.location.hash.slice(1); // Remove #
        const params = new URLSearchParams(hash);
        const state = {};

        for (const [key, value] of params) {
            state[key] = value;
        }

        return state;
    }

    if (onHashChange) {
        window.addEventListener('hashchange', async function() {
            const state = loadFromHash();
            await onHashChange(state);
        });
    }

    return {
        updateHash,
        loadFromHash,
        getParams: () => new URLSearchParams(window.location.hash.slice(1))
    };
}

// ===== Sort Management =====

/**
 * Create sort manager for table columns
 * @param {Object} options - Configuration options
 * @param {string} options.defaultColumn - Default column to sort by
 * @param {boolean} [options.defaultAscending=false] - Default sort direction
 * @param {Function} options.onSort - Callback when sort changes (receives column, ascending)
 * @returns {Object} - Object with methods to manage sorting
 */
function initSortManager(options) {
    const {
        defaultColumn,
        defaultAscending = false,
        onSort
    } = options;

    let currentSort = {
        column: defaultColumn,
        ascending: defaultAscending
    };

    function sortBy(column) {
        if (currentSort.column === column) {
            currentSort.ascending = !currentSort.ascending;
        } else {
            currentSort.column = column;
            currentSort.ascending = defaultAscending;
        }
        onSort(currentSort.column, currentSort.ascending);
    }

    function getSortArrow(column) {
        if (currentSort.column === column) {
            return currentSort.ascending ? '▲' : '▼';
        }
        return '';
    }

    function getSortClass(column) {
        return currentSort.column === column ? 'active' : '';
    }

    return {
        sortBy,
        getSortArrow,
        getSortClass,
        getColumn: () => currentSort.column,
        isAscending: () => currentSort.ascending
    };
}

// ===== Expandable Tree Management =====

/**
 * Create manager for expandable tree structures
 * @returns {Object} - Object with methods to manage expanded state
 */
function initExpandableTree() {
    const expandedItems = new Set();

    function toggle(key) {
        if (expandedItems.has(key)) {
            expandedItems.delete(key);
            return false;
        } else {
            expandedItems.add(key);
            return true;
        }
    }

    function isExpanded(key) {
        return expandedItems.has(key);
    }

    function clear() {
        expandedItems.clear();
    }

    function getAll() {
        return Array.from(expandedItems);
    }

    return {
        toggle,
        isExpanded,
        clear,
        getAll,
        add: (key) => expandedItems.add(key),
        delete: (key) => expandedItems.delete(key)
    };
}

// ===== Click Handler Setup =====

/**
 * Set up delegated click handlers on a container
 * @param {Object} options - Configuration options
 * @param {string} options.containerId - ID of container element
 * @param {Object} options.handlers - Map of selector -> handler function
 */
function setupClickHandlers(options) {
    const { containerId, handlers } = options;
    const container = document.getElementById(containerId);

    if (!container) {
        console.error(`Container element not found: ${containerId}`);
        return;
    }

    container.addEventListener('click', function(event) {
        // Don't handle clicks on links
        if (event.target.tagName === 'A') {
            return;
        }

        // Find the closest matching element
        let target = event.target;
        while (target && target !== container) {
            for (const [selector, handler] of Object.entries(handlers)) {
                if (target.matches && target.matches(selector)) {
                    handler(target, event);
                    return;
                }
                // Support class-based selectors
                if (selector.startsWith('.') && target.classList.contains(selector.slice(1))) {
                    handler(target, event);
                    return;
                }
            }
            target = target.parentElement;
        }
    });
}

// Export for use in other modules (if using modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        escapeHtml,
        escapeAttr,
        formatNumber,
        initSearchBox,
        populateDateSelector,
        initDateSelector,
        initHistoricalToggle,
        initUrlHashManager,
        initSortManager,
        initExpandableTree,
        setupClickHandlers
    };
}
