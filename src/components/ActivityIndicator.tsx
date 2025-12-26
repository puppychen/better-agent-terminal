import { useEffect, useState, useRef, useCallback } from 'react'
import { workspaceStore } from '../stores/workspace-store'

interface ActivityIndicatorProps {
  lastActivityTime?: number | null
  workspaceId?: string
  terminalId?: string
  size?: 'small' | 'medium'
}

// Activity timeout in milliseconds (10 seconds)
const ACTIVITY_TIMEOUT = 10000
// Interval for checking inactive state (5 seconds - less frequent than before)
const INACTIVE_CHECK_INTERVAL = 5000

export function ActivityIndicator({
  lastActivityTime: propActivityTime,
  workspaceId,
  terminalId,
  size = 'small'
}: ActivityIndicatorProps) {
  const [isActive, setIsActive] = useState(false)
  const lastActivityTimeRef = useRef<number | null>(null)

  // Function to get the current activity time
  const getActivityTime = useCallback((): number | null => {
    if (propActivityTime !== undefined) return propActivityTime

    if (terminalId) {
      const terminal = workspaceStore.getState().terminals.find(t => t.id === terminalId)
      return terminal?.lastActivityTime ?? null
    }

    if (workspaceId) {
      return workspaceStore.getWorkspaceLastActivity(workspaceId)
    }

    return null
  }, [propActivityTime, workspaceId, terminalId])

  // Function to check and update activity state
  const checkActivity = useCallback(() => {
    const activityTime = getActivityTime()
    lastActivityTimeRef.current = activityTime

    if (!activityTime) {
      setIsActive(prev => prev ? false : prev)
      return
    }

    const timeSinceActivity = Date.now() - activityTime
    const shouldBeActive = timeSinceActivity <= ACTIVITY_TIMEOUT
    setIsActive(prev => prev !== shouldBeActive ? shouldBeActive : prev)
  }, [getActivityTime])

  useEffect(() => {
    // Initial check
    checkActivity()

    // Subscribe to activity updates only (not all store changes)
    const unsubscribe = workspaceStore.subscribeToActivity(() => {
      const newActivityTime = getActivityTime()
      // Only check if activity time has changed (new activity detected)
      if (newActivityTime !== lastActivityTimeRef.current) {
        checkActivity()
      }
    })

    return () => unsubscribe()
  }, [checkActivity, getActivityTime])

  // Only run interval when active (to detect transition to inactive)
  // This avoids CPU usage when already inactive
  useEffect(() => {
    if (!isActive) return

    const interval = setInterval(() => {
      if (lastActivityTimeRef.current) {
        const timeSinceActivity = Date.now() - lastActivityTimeRef.current
        if (timeSinceActivity > ACTIVITY_TIMEOUT) {
          setIsActive(false)
        }
      }
    }, INACTIVE_CHECK_INTERVAL)

    return () => clearInterval(interval)
  }, [isActive])

  const className = `activity-indicator ${size} ${isActive ? 'active' : 'inactive'}`

  return <div className={className} />
}