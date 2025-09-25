package com.tomesonic.app.plugins

import android.widget.Toast
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AbsToast")
class AbsToast : Plugin() {

    @PluginMethod
    fun show(call: PluginCall) {
        val message = call.getString("message") ?: run {
            call.reject("Message is required")
            return
        }

        val duration = call.getString("duration", "short") ?: "short"
        val position = call.getString("position", "bottom") ?: "bottom"

        val toastDuration = when (duration.lowercase()) {
            "long" -> Toast.LENGTH_LONG
            else -> Toast.LENGTH_SHORT
        }

        activity.runOnUiThread {
            val toast = Toast.makeText(context, message, toastDuration)

            // Set toast position if specified
            when (position.lowercase()) {
                "top" -> toast.setGravity(android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL, 0, 100)
                "center" -> toast.setGravity(android.view.Gravity.CENTER, 0, 0)
                "bottom" -> toast.setGravity(android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL, 0, 100)
            }

            toast.show()
        }

        call.resolve()
    }

    @PluginMethod
    fun showSuccess(call: PluginCall) {
        val message = call.getString("message") ?: run {
            call.reject("Message is required")
            return
        }

        val duration = call.getString("duration", "short") ?: "short"
        val prefixedMessage = "✓ $message"

        showToastWithMessage(prefixedMessage, duration)
        call.resolve()
    }

    @PluginMethod
    fun showError(call: PluginCall) {
        val message = call.getString("message") ?: run {
            call.reject("Message is required")
            return
        }

        val duration = call.getString("duration", "short") ?: "short"
        val prefixedMessage = "✗ $message"

        showToastWithMessage(prefixedMessage, duration)
        call.resolve()
    }

    @PluginMethod
    fun showWarning(call: PluginCall) {
        val message = call.getString("message") ?: run {
            call.reject("Message is required")
            return
        }

        val duration = call.getString("duration", "short") ?: "short"
        val prefixedMessage = "⚠ $message"

        showToastWithMessage(prefixedMessage, duration)
        call.resolve()
    }

    @PluginMethod
    fun showInfo(call: PluginCall) {
        val message = call.getString("message") ?: run {
            call.reject("Message is required")
            return
        }

        val duration = call.getString("duration", "short") ?: "short"
        val prefixedMessage = "ℹ $message"

        showToastWithMessage(prefixedMessage, duration)
        call.resolve()
    }

    private fun showToastWithMessage(message: String, duration: String) {
        val toastDuration = when (duration.lowercase()) {
            "long" -> Toast.LENGTH_LONG
            else -> Toast.LENGTH_SHORT
        }

        activity.runOnUiThread {
            val toast = Toast.makeText(context, message, toastDuration)
            toast.setGravity(android.view.Gravity.BOTTOM or android.view.Gravity.CENTER_HORIZONTAL, 0, 100)
            toast.show()
        }
    }
}