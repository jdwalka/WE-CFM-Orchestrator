#include <napi.h>
#include <cmath>

// Perform Phase Angle Rotations (<||>) on a Float64Array
// We treat the input array as pairs of (x, y) vectors and apply a rotation.
// This is a placeholder for the proprietary quant logic.
Napi::Value RotatePhaseAngles(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsTypedArray()) {
        Napi::TypeError::New(env, "Expected a Float64Array as the first argument").ThrowAsJavaScriptException();
        return env.Null();
    }

    Napi::Float64Array input = info[0].As<Napi::Float64Array>();
    size_t length = input.ElementLength();
    double* data = input.Data();

    // Optional: a scalar angle passed as second argument, defaulting to Pi / 4.
    double angle = 0.78539816339; // 45 degrees
    if (info.Length() > 1 && info[1].IsNumber()) {
        angle = info[1].As<Napi::Number>().DoubleValue();
    }

    double cosA = std::cos(angle);
    double sinA = std::sin(angle);

    // Process array in pairs (x, y)
    for (size_t i = 0; i < length - 1; i += 2) {
        double x = data[i];
        double y = data[i + 1];

        // Apply rotation
        data[i]     = x * cosA - y * sinA;
        data[i + 1] = x * sinA + y * cosA;
    }

    // Returns the mutated array (since we mutated the pointer directly, we can just return the same array)
    return input;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set(Napi::String::New(env, "rotatePhaseAngles"), Napi::Function::New(env, RotatePhaseAngles));
    return exports;
}

NODE_API_MODULE(quant_math, Init)
