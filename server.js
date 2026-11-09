const express = require('express');
const cors = require('cors');

const app = express();

// هذا السطر مهم جداً للاستضافة، يسمح للمنصة باختيار المنفذ المناسب
const PORT = process.env.PORT || 3000; 

// تفعيل قراءة البيانات بصيغة JSON
app.use(express.json());
// تفعيل CORS لكي تستطيع الواجهة (index.html) الاتصال بالسيرفر
app.use(cors());

// مصفوفة مؤقتة لحفظ طلبات التاكسي
let taxiRequests = [];

// 1. مسار لاستقبال طلب تاكسي جديد من الزبون
app.post('/api/request-taxi', (req, res) => {
    const { customerName, phone, location } = req.body;

    // التحقق من أن جميع البيانات وصلت
    if (!customerName || !phone || !location) {
        return res.status(400).json({ message: "الرجاء إدخال جميع البيانات المطلوبة" });
    }

    const newRequest = {
        id: Date.now(), // رقم تعريفي فريد للطلب
        customerName,
        phone,
        location,
        status: 'قيد الانتظار', // حالة الطلب الافتراضية
        timestamp: new Date()
    };

    taxiRequests.push(newRequest);
    console.log("طلب جديد وصل:", newRequest);

    res.status(201).json({ 
        message: "تم استلام طلبك بنجاح، سيتصل بك السائق قريباً", 
        requestId: newRequest.id 
    });
});

// 2. مسار للسائق لكي يرى جميع الطلبات
app.get('/api/requests', (req, res) => {
    res.json(taxiRequests);
});

// 3. مسار لتغيير حالة الطلب (مثلاً عند قبول السائق للطلب أو إكماله)
app.put('/api/requests/:id', (req, res) => {
    const requestId = parseInt(req.params.id);
    const { status } = req.body;

    const requestIndex = taxiRequests.findIndex(r => r.id === requestId);
    
    if (requestIndex !== -1) {
        taxiRequests[requestIndex].status = status;
        res.json({ 
            message: "تم تحديث حالة الطلب بنجاح", 
            request: taxiRequests[requestIndex] 
        });
    } else {
        res.status(404).json({ message: "عذراً، الطلب غير موجود" });
    }
});

// صفحة رئيسية بسيطة للتأكد من أن السيرفر يعمل
app.get('/', (req, res) => {
    res.send('🚕 سيرفر تاكسي ابن الجنوب يعمل بنجاح!');
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`🚕 سيرفر تاكسي ابن الجنوب يعمل الآن على المنفذ ${PORT}`);
});
