// wiring-agent.js
// Centralizes event wiring for network health, escalation, and circuit breaker UI updates
(function () {
    if (window.WiringAgent) return;

    // Listen for all relevant events and propagate to UI
    function handleNetworkHealthUpdate() {
        if (window.NetworkHealthDashboard?.render) {
            window.NetworkHealthDashboard.render();
        }
    }

    function handleNetworkHealthAlert() {
        if (window.NetworkHealthDashboard?.render) {
            window.NetworkHealthDashboard.render();
        }
    }

    function handleCircuitBreakerEvent(e) {
        // Optionally, add UI hooks for circuit breaker notifications here
        if (window.NetworkHealthDashboard?.render) {
            window.NetworkHealthDashboard.render();
        }
        // Could also trigger toast/alert UI if needed
    }

    window.addEventListener('network-health-update', handleNetworkHealthUpdate);
    window.addEventListener('network-health-alert', handleNetworkHealthAlert);
    window.addEventListener('network-transport-update', handleNetworkHealthUpdate);
    window.addEventListener('circuit-breaker-event', handleCircuitBreakerEvent);

    // Initial render
    setTimeout(() => {
        if (window.NetworkHealthDashboard?.render) {
            window.NetworkHealthDashboard.render();
        }
    }, 200);

    window.WiringAgent = {
        handleNetworkHealthUpdate,
        handleNetworkHealthAlert,
        handleCircuitBreakerEvent
    };
})();
