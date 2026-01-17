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

  // Use one-shot setTimeout instead of interval to reduce CPU usage
  // Only schedule timeout when active, and only for the exact moment it should turn off
  useEffect(() => {
    if (!isActive || !lastActivityTimeRef.current) return

    const timeSinceActivity = Date.now() - lastActivityTimeRef.current
    const remainingTime = ACTIVITY_TIMEOUT - timeSinceActivity + 100 // +100ms buffer

    if (remainingTime <= 0) {
      setIsActive(false)
      return
    }

    const timeout = setTimeout(() => {
      // Double-check the activity time hasn't been updated
      if (lastActivityTimeRef.current) {
        const currentTimeSince = Date.now() - lastActivityTimeRef.current
        if (currentTimeSince > ACTIVITY_TIMEOUT) {
          setIsActive(false)
        }
      }
    }, remainingTime)

    return () => clearTimeout(timeout)
  }, [isActive])

  const className = `activity-indicator ${size} ${isActive ? 'active' : 'inactive'}`

  return <div className={className} />
}