<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: POST, GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Authorization');

// معالجة طلبات OPTIONS لـ CORS
if ($_SERVER['REQUEST_METHOD'] == 'OPTIONS') {
    http_response_code(200);
    exit(0);
}

// السماح فقط لطلبات POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode([
        'success' => false,
        'message' => 'الطريقة غير مسموحة. استخدم POST فقط.'
    ]);
    exit;
}

// استقبال البيانات من العميل
$input = json_decode(file_get_contents('php://input'), true);

// التحقق من وجود البيانات
if (!$input) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => 'لم يتم استقبال أي بيانات'
    ]);
    exit;
}

// استخراج البيانات
$user_id = $input['user_id'] ?? '';
$liveness_id = $input['liveness_id'] ?? '';
$spoof_ip = $input['spoof_ip'] ?? '';
$transaction_id = $input['transaction_id'] ?? '';

// التحقق من البيانات المطلوبة
if (empty($user_id) || empty($liveness_id) || empty($transaction_id)) {
    http_response_code(400);
    echo json_encode([
        'success' => false,
        'message' => 'بيانات ناقصة: user_id, liveness_id, transaction_id مطلوبة'
    ]);
    exit;
}

try {
    // تسجيل البيانات في ملف log
    $log_data = [
        'timestamp' => date('Y-m-d H:i:s'),
        'user_id' => $user_id,
        'liveness_id' => $liveness_id,
        'spoof_ip' => $spoof_ip,
        'transaction_id' => $transaction_id,
        'ip_address' => $_SERVER['REMOTE_ADDR'] ?? 'غير معروف'
    ];
    
    // إنشاء مجلد logs إذا لم يكن موجوداً
    if (!is_dir('logs')) {
        mkdir('logs', 0755, true);
    }
    
    // حفظ في ملف log
    $log_entry = json_encode($log_data, JSON_UNESCAPED_UNICODE) . PHP_EOL;
    file_put_contents('logs/liveness_verifications.log', $log_entry, FILE_APPEND);
    
    // يمكنك هنا إضافة حفظ في قاعدة البيانات إذا أردت
    // مثال: حفظ في MySQL أو SQLite
    
    // إرجاع رد ناجح
    http_response_code(200);
    echo json_encode([
        'success' => true,
        'message' => 'تم حفظ بيانات التحقق بنجاح',
        'data_received' => $log_data,
        'server_time' => date('Y-m-d H:i:s')
    ], JSON_UNESCAPED_UNICODE);
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'message' => 'خطأ في الخادم: ' . $e->getMessage()
    ], JSON_UNESCAPED_UNICODE);
}
?>
