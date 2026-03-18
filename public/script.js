// Конфигурация
const API_URL = window.location.origin; // Используем текущий домен
let USER_ID = null;
let currentCarId = null;
let currentCarData = null;
let allCars = [];
let charts = { category: null, price: null };
let editingRecord = null;

// Функция для безопасных fetch запросов
async function fetchWithAuth(url, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    // Добавляем Telegram данные для верификации
    if (window.Telegram?.WebApp?.initData) {
        headers['X-Telegram-Init-Data'] = window.Telegram.WebApp.initData;
    }
    
    try {
        const response = await fetch(url, {
            ...options,
            headers,
            credentials: 'omit'
        });
        
        if (response.status === 429) {
            showToast('Слишком много запросов, подождите немного');
            return null;
        }
        
        if (response.status === 401) {
            showToast('Ошибка авторизации');
            return null;
        }
        
        return response;
    } catch (error) {
        console.error('Network error:', error);
        showToast('Ошибка соединения');
        return null;
    }
}

// ================ АВТОРИЗАЦИЯ ================
function getTelegramUserId() {
    console.log("[TG] Начало получения user ID");
    
    if (window.Telegram?.WebApp) {
        try {
            window.Telegram.WebApp.ready();
            window.Telegram.WebApp.expand();
            
            const user = window.Telegram.WebApp.initDataUnsafe?.user;
            if (user?.id) {
                USER_ID = "tg_" + user.id;
                console.log("[TG] Успех! ID пользователя:", USER_ID);
                sessionStorage.setItem("autolife_user_id", USER_ID);
                return true;
            }
        } catch (e) {
            console.error("[TG] Ошибка доступа к WebApp:", e);
        }
    }
    
    // Fallback: проверяем sessionStorage
    USER_ID = sessionStorage.getItem("autolife_user_id");
    if (USER_ID && USER_ID.startsWith('tg_')) {
        console.log("[TG] Восстановлен из sessionStorage:", USER_ID);
        return true;
    }
    
    // Генерируем временный ID для тестирования
    USER_ID = "test_" + Date.now().toString(36);
    sessionStorage.setItem("autolife_user_id", USER_ID);
    console.log("[TG] Временный тестовый ID:", USER_ID);
    return false;
}

// ================ ТЕМА ================
function applyUserTheme() {
    const select = document.getElementById('themeSelect');
    if (!select) return;
    
    const saved = localStorage.getItem('user_theme_choice') || 'system';
    select.value = saved;
    
    let effective = saved;
    if (saved === 'system') {
        effective = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    
    document.documentElement.setAttribute('data-theme', effective);
    
    // Сохраняем выбор
    localStorage.setItem('user_theme_choice', saved);
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyUserTheme);

// ================ УВЕДОМЛЕНИЯ ================
function showToast(message) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2000);
}

// ================ МОДАЛЬНЫЕ ОКНА ================
function showModal(modalId) {
    document.getElementById(modalId).classList.remove('hidden');
}

function hideModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

// ================ ЭКРАНИРОВАНИЕ ================
function escapeHtml(unsafe) {
    if (unsafe == null) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;")
        .replace(/\(/g, "&#40;")
        .replace(/\)/g, "&#41;");
}

// ================ АВТОМОБИЛИ ================
async function loadCars() {
    if (!USER_ID) {
        console.error("[loadCars] USER_ID не установлен!");
        showToast("Ошибка: пользователь не идентифицирован");
        return;
    }

    try {
        const res = await fetchWithAuth(`${API_URL}/cars/${USER_ID}`);
        if (!res) return;
        
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
        const cars = await res.json();
        allCars = cars || [];
        updateCarList(allCars);

        if (allCars.length > 0 && !currentCarId) {
            await selectCar(allCars[0].id);
        } else if (allCars.length === 0) {
            document.getElementById('historyList').innerHTML = '';
            document.getElementById('historyEmpty').classList.remove('hidden');
        }
    } catch (err) {
        console.error("[loadCars] Ошибка:", err);
        showToast("Не удалось загрузить список автомобилей");
    }
}

function updateCarList(cars) {
    const carList = document.getElementById('carList');

    if (cars.length === 0) {
        carList.innerHTML = `
            <div class="empty-state" style="padding: 12px 0;">
                <div class="empty-icon" style="font-size:32px; margin-bottom:8px;">🚗</div>
                <div>Добавьте ваш первый автомобиль</div>
            </div>
        `;
        return;
    }

    carList.innerHTML = cars.map(car => `
        <div class="car-chip ${car.id === currentCarId ? 'active' : ''}"
             onclick="selectCar(${car.id})">
            <div class="car-chip-title">${escapeHtml(car.car_name)}</div>
            <div class="car-chip-sub">
                ${escapeHtml(car.reg_number || '—')} · ${(Number(car.mileage) || 0).toLocaleString('ru-RU')} км
            </div>
        </div>
    `).join('');
}

function showAddCarModal() {
    document.getElementById('newCarName').value = '';
    document.getElementById('newCarReg').value = '';
    document.getElementById('newCarMileage').value = '';
    showModal('addCarModal');
}

async function addNewCar() {
    const name = document.getElementById('newCarName').value.trim();
    const reg = document.getElementById('newCarReg').value.trim();
    const mileage = parseInt(document.getElementById('newCarMileage').value) || 0;

    if (!name) {
        showToast('Введите название');
        return;
    }

    try {
        const response = await fetchWithAuth(`${API_URL}/add-car`, {
            method: 'POST',
            body: JSON.stringify({
                user_id: USER_ID,
                car_name: name,
                reg_number: reg,
                mileage: mileage
            })
        });

        if (response && response.ok) {
            hideModal('addCarModal');
            showToast('Авто успешно добавлено');
            await loadCars();
            hideModal('carsModal');
        } else if (response) {
            const err = await response.json();
            showToast(err.error || 'Ошибка добавления');
        }
    } catch (error) {
        console.error('Ошибка:', error);
        showToast('Ошибка при добавлении');
    }
}

function openCarsModal() {
    const listEl = document.getElementById('carsModalList');
    if (!listEl) return;

    if (!allCars || allCars.length === 0) {
        listEl.innerHTML = `
            <div class="empty-state" style="padding: 16px 0;">
                <div class="empty-icon">🚗</div>
                <div>Пока нет ни одного авто</div>
            </div>
        `;
    } else {
        listEl.innerHTML = allCars.map(car => `
            <div class="cars-modal-item ${car.id === currentCarId ? 'active' : ''}">
                <div class="cars-modal-main" onclick="handleSelectCarFromModal(${car.id})">
                    <div class="cars-modal-title">${escapeHtml(car.car_name)}</div>
                    <div class="cars-modal-sub">
                        ${escapeHtml(car.reg_number || '—')} · ${(Number(car.mileage) || 0).toLocaleString('ru-RU')} км
                    </div>
                </div>
                <div style="display:flex; gap:4px;">
                    <button class="icon-btn" onclick="handleSelectCarFromModal(${car.id}); event.stopPropagation();">
                        <span class="material-symbols-outlined" style="font-size:18px;">directions_car</span>
                    </button>
                    <button class="icon-btn" style="background:rgba(239,68,68,0.08); color:#b91c1c;" onclick="deleteCar(${car.id}); event.stopPropagation();">
                        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
                    </button>
                </div>
            </div>
        `).join('');
    }
    showModal('carsModal');
}

function handleSelectCarFromModal(id) {
    selectCar(id);
    hideModal('carsModal');
}

async function deleteCar(id) {
    if (!confirm('Удалить автомобиль и все его записи?')) return;
    
    try {
        const res = await fetchWithAuth(`${API_URL}/cars/${id}`, {
            method: 'DELETE',
            body: JSON.stringify({ user_id: USER_ID })
        });
        
        if (res && res.ok) {
            await loadCars();
            hideModal('carsModal');
            
            if (!allCars.some(c => c.id === currentCarId) && allCars.length > 0) {
                await selectCar(allCars[0].id);
            } else if (allCars.length === 0) {
                currentCarId = null;
                currentCarData = null;
            }
            showToast('Авто удалён');
        } else if (res) {
            const data = await res.json();
            showToast(data.error || 'Ошибка удаления');
        }
    } catch (e) {
        console.error('Ошибка удаления авто:', e);
        showToast('Ошибка удаления авто');
    }
}

async function selectCar(carId) {
    currentCarId = carId;
    updateCarList(allCars);
    await loadDashboard();
    await loadStats();
}

// ================ ДАШБОРД ================
function calculateFuelConsumption(history) {
    if (!history || history.length < 2) return '0.0';
    
    const fuels = history
        .filter(h => h.type === 'fuel')
        .sort((a, b) => new Date(b.date) - new Date(a.date));
    
    if (fuels.length < 2) return '0.0';
    
    const lastFuel = fuels[0];
    const prevFuel = fuels[1];
    
    const distance = lastFuel.mileage - prevFuel.mileage;
    if (distance <= 0) return '0.0';
    
    const consumption = (lastFuel.liters / distance) * 100;
    return consumption.toFixed(1);
}

async function loadDashboard() {
    if (!currentCarId) return;
    
    try {
        const response = await fetchWithAuth(`${API_URL}/dashboard/${currentCarId}?user_id=${USER_ID}`);
        if (!response) return;
        
        const data = await response.json();
        currentCarData = data;
        updateDashboardUI();
    } catch (error) {
        console.error('Ошибка загрузки дашборда:', error);
    }
}

function updateDashboardUI() {
    if (!currentCarData) return;
    
    const data = currentCarData;
    
    const consumption = calculateFuelConsumption(data.history);
    document.getElementById('consumption').innerHTML = `${consumption}<span class="stat-unit">л/100км</span>`;
    
    document.getElementById('mileage').innerHTML = `${(data.car?.mileage || 0).toLocaleString()}<span class="stat-unit">км</span>`;
    
    const fuelCount = data.history?.filter(h => h.type === 'fuel').length || 0;
    document.getElementById('fuelCount').innerHTML = fuelCount;
    
    const mileage = data.car?.mileage || 0;
    const interval = data.car?.oil_change_interval || 10000;
    const remaining = Math.max(0, interval - (mileage % interval));
    const percent = ((mileage % interval) / interval) * 100;
    
    document.getElementById('oilRemaining').innerText = `${remaining} км`;
    document.getElementById('oilProgress').style.width = `${Math.min(percent, 100)}%`;
    document.getElementById('oilInterval').innerText = `${interval.toLocaleString()} км`;
    
    updateHistoryUI(data.history);
    
    if (data.car) {
        document.getElementById('settingsName').value = data.car.car_name || '';
        document.getElementById('settingsReg').value = data.car.reg_number || '';
        document.getElementById('settingsMileage').value = data.car.mileage || 0;
        document.getElementById('settingsLastOilChange').value = data.car.mileage_last_oil_change || 0;
        document.getElementById('settingsOilInterval').value = data.car.oil_change_interval || 10000;
    }
}

function updateHistoryUI(history) {
    const historyList = document.getElementById('historyList');
    const historyEmpty = document.getElementById('historyEmpty');
    
    if (!history || history.length === 0) {
        historyList.innerHTML = '';
        historyEmpty.classList.remove('hidden');
        return;
    }
    
    historyEmpty.classList.add('hidden');
    historyList.innerHTML = history.slice(0, 5).map(item => {
        const icon = item.type === 'fuel' ? '⛽' :
                    item.category?.includes('🛠') ? '🛠' :
                    item.category?.includes('🧼') ? '🧼' :
                    item.category?.includes('📄') ? '📄' :
                    item.category?.includes('⚙️') ? '⚙️' : '📦';
        const commentText = item.comments || item.station_name || '';
        
        return `
        <div class="history-item">
            <div class="history-icon">${icon}</div>
            <div class="history-content">
                <div class="history-title">${escapeHtml(item.category || 'Заправка')}</div>
                <div class="history-meta">
                    ${new Date(item.date).toLocaleDateString('ru-RU')}
                    ${item.mileage ? ` · ${item.mileage} км` : ''}
                </div>
                ${commentText ? `<div class="history-comment">${escapeHtml(commentText)}</div>` : ''}
            </div>
            <div class="history-right">
                <div class="history-amount ${item.type}">-${item.amount.toLocaleString()} ₽</div>
                <div class="history-actions">
                    <button class="icon-btn" onclick="editHistoryItem('${item.type}', ${item.id}); event.stopPropagation();">✏️</button>
                    <button class="icon-btn" onclick="deleteHistoryItem('${item.type}', ${item.id}); event.stopPropagation();">🗑</button>
                </div>
            </div>
        </div>
    `}).join('');
}

// ================ СОХРАНЕНИЕ ================
async function saveRecord() {
    const type = document.getElementById('recordType').value;
    const amount = parseFloat(document.getElementById('amount').value);
    const comment = document.getElementById('comment').value;
    
    if (editingRecord && type !== editingRecord.type) {
        showToast('Нельзя менять тип записи');
        return;
    }
    
    if (!amount || amount <= 0) {
        showToast('Введите сумму');
        return;
    }
    
    const payload = {
        car_id: currentCarId,
        user_id: USER_ID,
        amount: amount,
        comments: comment
    };
    
    try {
        if (type === 'fuel') {
            const liters = parseFloat(document.getElementById('liters').value);
            const mileage = parseInt(document.getElementById('fuelMileage').value);
            
            if (!liters || !mileage) {
                showToast('Заполните литры и пробег');
                return;
            }
            
            if (currentCarData?.car?.mileage && mileage <= currentCarData.car.mileage) {
                showToast('Пробег должен быть больше текущего');
                return;
            }
            
            payload.liters = liters;
            payload.mileage = mileage;
            payload.full_tank = document.getElementById('fullTank').checked;
            payload.station_name = document.getElementById('station').value;
            
            const url = editingRecord && editingRecord.type === 'fuel'
                ? `${API_URL}/fuel-records/${editingRecord.id}`
                : `${API_URL}/add-fuel`;
            const method = editingRecord && editingRecord.type === 'fuel' ? 'PUT' : 'POST';
            
            const response = await fetchWithAuth(url, {
                method,
                body: JSON.stringify(payload)
            });
            
            if (response && response.ok) {
                showToast(editingRecord ? '⛽ Заправка изменена' : '⛽ Заправка добавлена');
                await loadDashboard();
                clearForm();
                editingRecord = null;
                resetSaveButtonText();
                switchTab('home', document.querySelector('.nav-btn'));
            }
        } else {
            payload.category = document.getElementById('category').value;
            const serviceMileage = parseInt(document.getElementById('serviceMileage').value);
            if (payload.category === '⚙️ ТО' && serviceMileage) {
                payload.mileage = serviceMileage;
            }
            
            const url = editingRecord && editingRecord.type === 'expense'
                ? `${API_URL}/car-expenses/${editingRecord.id}`
                : `${API_URL}/add-expense`;
            const method = editingRecord && editingRecord.type === 'expense' ? 'PUT' : 'POST';
            
            const response = await fetchWithAuth(url, {
                method,
                body: JSON.stringify(payload)
            });
            
            if (response && response.ok) {
                showToast(editingRecord ? '📦 Запись изменена' : '📦 Расход добавлен');
                await loadDashboard();
                clearForm();
                editingRecord = null;
                resetSaveButtonText();
                switchTab('home', document.querySelector('.nav-btn'));
            }
        }
    } catch (error) {
        console.error('Ошибка сохранения:', error);
        showToast('Ошибка при сохранении');
    }
}

function clearForm() {
    document.getElementById('amount').value = '';
    document.getElementById('comment').value = '';
    document.getElementById('liters').value = '';
    document.getElementById('fuelMileage').value = '';
    document.getElementById('station').value = '';
    document.getElementById('fullTank').checked = false;
    document.getElementById('serviceMileage').value = '';
    editingRecord = null;
    resetSaveButtonText();
}

// ================ НАСТРОЙКИ ================
async function updateCarSettings() {
    const name = document.getElementById('settingsName').value.trim();
    const reg = document.getElementById('settingsReg').value.trim();
    const mileage = parseInt(document.getElementById('settingsMileage').value);
    const lastOilChange = parseInt(document.getElementById('settingsLastOilChange').value);
    const oilInterval = parseInt(document.getElementById('settingsOilInterval').value);
    
    if (!name) {
        showToast('Введите название');
        return;
    }
    
    try {
        const response = await fetchWithAuth(`${API_URL}/update-car/${currentCarId}`, {
            method: 'PUT',
            body: JSON.stringify({
                user_id: USER_ID,
                car_name: name,
                reg_number: reg,
                mileage: mileage,
                mileage_last_oil_change: lastOilChange,
                oil_change_interval: oilInterval
            })
        });
        
        if (response && response.ok) {
            showToast('Настройки сохранены');
            await loadDashboard();
        }
    } catch (error) {
        showToast('Ошибка при сохранении');
    }
}

// ================ СТАТИСТИКА ================
async function loadStats() {
    if (!currentCarId) return;
    const period = document.getElementById('statsPeriod').value;
    
    try {
        const response = await fetchWithAuth(`${API_URL}/stats/${currentCarId}/${period}?user_id=${USER_ID}`);
        if (!response) return;
        
        const stats = await response.json();
        updateCharts(stats);
    } catch (error) {
        console.error('Ошибка статистики:', error);
    }
}

function updateCharts(stats) {
    const ctxCat = document.getElementById('chartCat').getContext('2d');
    const statsEmpty = document.getElementById('statsEmpty');
    const fuelEmpty = document.getElementById('fuelEmpty');
    
    if (stats.expenses?.length > 0) {
        statsEmpty.classList.add('hidden');
        if (charts.category) charts.category.destroy();
        
        charts.category = new Chart(ctxCat, {
            type: 'doughnut',
            data: {
                labels: stats.expenses.map(e => e.category),
                datasets: [{
                    data: stats.expenses.map(e => e.total),
                    backgroundColor: ['#007aff', '#34c759', '#ff9f0a', '#ff3b30', '#5856d6', '#af52de'],
                    borderWidth: 0
                }]
            },
            options: {
                cutout: '70%',
                plugins: { legend: { position: 'bottom' } },
                responsive: true
            }
        });
    } else {
        statsEmpty.classList.remove('hidden');
    }
    
    updateFuelPriceChart(fuelEmpty);
}

function updateFuelPriceChart(fuelEmpty) {
    if (!currentCarData?.history) return;
    
    const fuelEntries = currentCarData.history
        .filter(h => h.type === 'fuel')
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(-10);
    
    if (fuelEntries.length === 0) {
        fuelEmpty.classList.remove('hidden');
        return;
    }
    
    fuelEmpty.classList.add('hidden');
    const ctxPrice = document.getElementById('chartPrice').getContext('2d');
    
    if (charts.price) charts.price.destroy();
    
    charts.price = new Chart(ctxPrice, {
        type: 'line',
        data: {
            labels: fuelEntries.map(e => new Date(e.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })),
            datasets: [{
                label: 'Цена за литр (₽)',
                data: fuelEntries.map(e => e.price_per_liter),
                borderColor: '#ff9f0a',
                backgroundColor: 'rgba(255,159,10,0.1)',
                tension: 0.3,
                fill: true,
                pointBackgroundColor: '#ff9f0a',
                pointRadius: 4
            }]
        },
        options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
                y: {
                    beginAtZero: false,
                    ticks: { callback: value => value + ' ₽' }
                }
            }
        }
    });
}

// ================ НАВИГАЦИЯ ================
function switchTab(tabName, btn) {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });
    
    document.getElementById(tabName + 'Tab').classList.add('active');
    
    document.querySelectorAll('.nav-btn').forEach(b => {
        b.classList.remove('active');
    });
    if (btn) btn.classList.add('active');
    
    if (tabName === 'stats') {
        setTimeout(() => loadStats(), 100);
    }
}

// ================ ВСПОМОГАТЕЛЬНЫЕ ================
function toggleRecordFields() {
    const type = document.getElementById('recordType').value;
    const fuelFields = document.getElementById('fuelFields');
    const expenseFields = document.getElementById('expenseFields');
    
    if (type === 'fuel') {
        fuelFields.classList.remove('hidden');
        expenseFields.classList.add('hidden');
        
        if (currentCarData?.car?.mileage) {
            document.getElementById('fuelMileage').placeholder = `Текущий: ${currentCarData.car.mileage}`;
        }
    } else {
        fuelFields.classList.add('hidden');
        expenseFields.classList.remove('hidden');
    }
    updateServiceFieldsVisibility();
}

function updateServiceFieldsVisibility() {
    const categorySelect = document.getElementById('category');
    if (!categorySelect) return;
    const category = categorySelect.value;
    const serviceFields = document.getElementById('serviceFields');
    const commentEl = document.getElementById('comment');
    
    if (category === '⚙️ ТО') {
        serviceFields.classList.remove('hidden');
        if (commentEl) {
            commentEl.placeholder = 'Пункты работ, каждый с новой строки';
        }
    } else {
        serviceFields.classList.add('hidden');
        if (commentEl) {
            commentEl.placeholder = 'Дополнительно';
        }
    }
}

function resetSaveButtonText() {
    const saveBtn = document.querySelector('#addTab .card .btn');
    if (saveBtn) {
        saveBtn.textContent = 'Сохранить';
    }
}

function setEditSaveButtonText() {
    const saveBtn = document.querySelector('#addTab .card .btn');
    if (saveBtn) {
        saveBtn.textContent = 'Сохранить изменения';
    }
}

function findHistoryItem(type, id) {
    if (!currentCarData || !currentCarData.history) return null;
    return currentCarData.history.find(item => item.type === type && item.id === id) || null;
}

function editHistoryItem(type, id) {
    const item = findHistoryItem(type, id);
    if (!item) {
        showToast('Запись не найдена');
        return;
    }
    
    editingRecord = { id, type };
    setEditSaveButtonText();
    const navButtons = document.querySelectorAll('.nav-btn');
    switchTab('add', navButtons[2]);
    
    const typeSelect = document.getElementById('recordType');
    if (type === 'fuel') {
        typeSelect.value = 'fuel';
        toggleRecordFields();
        document.getElementById('amount').value = item.amount || '';
        document.getElementById('liters').value = item.liters || '';
        document.getElementById('fuelMileage').value = item.mileage || '';
        document.getElementById('station').value = item.station_name || '';
        document.getElementById('fullTank').checked = !!item.full_tank;
        document.getElementById('comment').value = item.comments || '';
    } else {
        typeSelect.value = 'expense';
        toggleRecordFields();
        document.getElementById('amount').value = item.amount || '';
        const categorySelect = document.getElementById('category');
        if (categorySelect && item.category) {
            categorySelect.value = item.category;
        }
        updateServiceFieldsVisibility();
        if (item.category === '⚙️ ТО' && typeof item.mileage === 'number') {
            document.getElementById('serviceMileage').value = item.mileage || '';
        } else {
            document.getElementById('serviceMileage').value = '';
        }
        document.getElementById('comment').value = item.comments || '';
    }
}

async function deleteHistoryItem(type, id) {
    if (!confirm('Удалить запись?')) return;
    
    try {
        const endpoint = type === 'fuel'
            ? `/fuel-records/${id}`
            : `/car-expenses/${id}`;
        
        const response = await fetchWithAuth(`${API_URL}${endpoint}`, {
            method: 'DELETE',
            body: JSON.stringify({ user_id: USER_ID })
        });
        
        if (response && response.ok) {
            showToast('Запись удалена');
            await loadDashboard();
        } else if (response) {
            showToast('Не удалось удалить запись');
        }
    } catch (error) {
        console.error('Ошибка удаления:', error);
        showToast('Ошибка удаления');
    }
}

function quickAction(action) {
    switchTab('add', document.querySelectorAll('.nav-btn')[2]);
    
    const typeSelect = document.getElementById('recordType');
    const categorySelect = document.getElementById('category');
    
    if (action === 'fuel') {
        typeSelect.value = 'fuel';
        if (currentCarData?.car?.mileage) {
            document.getElementById('fuelMileage').value = currentCarData.car.mileage;
        }
    } else {
        typeSelect.value = 'expense';
        
        const actions = {
            'oil': '⚙️ ТО',
            'wash': '🧼 Мойка',
            'insurance': '📄 Страховка',
            'service': '⚙️ ТО',
            'other': '📦 Прочее'
        };
        categorySelect.value = actions[action] || '📦 Прочее';
    }
    
    toggleRecordFields();
}

// ================ ЗАПУСК ================
async function startApp() {
    console.log("🚀 Запуск приложения...");
    
    getTelegramUserId();
    applyUserTheme();
    await loadCars();
    
    toggleRecordFields();
    updateServiceFieldsVisibility();
    
    console.log("✅ Приложение готово. USER_ID =", USER_ID);
}

// Глобальные функции
window.switchTab = switchTab;
window.toggleRecordFields = toggleRecordFields;
window.saveRecord = saveRecord;
window.quickAction = quickAction;
window.selectCar = selectCar;
window.showAddCarModal = showAddCarModal;
window.addNewCar = addNewCar;
window.hideModal = hideModal;
window.updateCarSettings = updateCarSettings;
window.loadStats = loadStats;
window.editHistoryItem = editHistoryItem;
window.deleteHistoryItem = deleteHistoryItem;
window.updateServiceFieldsVisibility = updateServiceFieldsVisibility;
window.openCarsModal = openCarsModal;
window.handleSelectCarFromModal = handleSelectCarFromModal;
window.deleteCar = deleteCar;
window.applyUserTheme = applyUserTheme;

// Запуск при загрузке страницы
window.addEventListener('load', startApp);