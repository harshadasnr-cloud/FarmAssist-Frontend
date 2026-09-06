/**
 * useScanQueue — persistent scan job queue hook
 *
 * Stores job IDs in localStorage so they survive page refreshes.
 * Polls the backend for PENDING/PROCESSING jobs every 4 seconds.
 * Fires a callback (and shows a toast-style notification) when a job completes.
 */
import { useState, useEffect, useCallback } from 'react';
import api from '../axios';
import Swal from 'sweetalert2';

const STORAGE_KEY = 'farmassist_scan_jobs';

/** Read the persisted job list from localStorage */
function loadPersistedJobs() {
  try {
    const jobs = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return jobs.filter(j => j.status === 'PENDING' || j.status === 'PROCESSING');
  } catch {
    return [];
  }
}

/** Write the current job list back to localStorage */
function persistJobs(jobs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(jobs));
}

export function useScanQueue() {
  const [jobs, setJobs] = useState(loadPersistedJobs);

  // Keep localStorage in sync whenever jobs change
  useEffect(() => {
    persistJobs(jobs);
  }, [jobs]);

  // Fetch historical jobs from backend to populate queue
  const fetchHistory = useCallback(async () => {
    try {
      const { data } = await api.get('/api/scan/jobs/');
      setJobs(prev => {
        const newJobs = [];
        const serverJobsMap = new Map(data.map(j => [Number(j.id), j]));

        // Add jobs from prev that are still pending/processing on server
        prev.forEach(localJob => {
          const serverJob = serverJobsMap.get(Number(localJob.id));
          if (serverJob) {
             if (serverJob.status === 'PENDING' || serverJob.status === 'PROCESSING') {
               newJobs.push({ ...localJob, ...serverJob });
             }
          }
        });

        // Add any new pending/processing jobs from server that weren't in prev
        data.forEach(serverJob => {
          if (serverJob.status === 'PENDING' || serverJob.status === 'PROCESSING') {
            if (!newJobs.find(j => Number(j.id) === Number(serverJob.id))) {
              newJobs.push(serverJob);
            }
          }
        });

        return newJobs;
      });
    } catch (err) {
      console.warn("Could not fetch scan history:", err?.message);
    }
  }, []);

  // Fetch on mount
  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Polling fallback: if there are any pending jobs, poll every 5 seconds
  // in case the SSE event is missed.
  useEffect(() => {
    const hasPending = jobs.some(j => j.status === 'PENDING' || j.status === 'PROCESSING');
    if (!hasPending) return;

    const intervalId = setInterval(fetchHistory, 5000);
    return () => clearInterval(intervalId);
  }, [jobs, fetchHistory]);

  /**
   * addJob — called immediately after POST /api/scan/submit/ returns
   * @param {number} jobId
   * @param {string} cropHint
   */
  const addJob = useCallback((jobId, cropHint = '') => {
    setJobs(prev => {
      // Deduplicate: don't add the same job_id twice
      if (prev.some(j => j.id === jobId)) return prev;
      return [
        { id: jobId, status: 'PENDING', crop_hint: cropHint, created_at: new Date().toISOString(), result: null, error_message: '' },
        ...prev,
      ];
    });

    Swal.fire({
      icon: 'info',
      title: 'Task Queued',
      text: 'Your scan request has been submitted and is processing.',
      position: 'center',
      showConfirmButton: false,
      timer: 2000
    });
  }, []);

  /**
   * removeJob — lets the user remove a completed/failed job from their history
   */
  const removeJob = useCallback((jobId) => {
    setJobs(prev => prev.filter(j => j.id !== jobId));
  }, []);

  /**
   * Listen to the SSE custom event dispatched by RootLayout
   * and automatically clear the completed/failed job from the queue
   */
  useEffect(() => {
    const handleJobUpdate = (e) => {
      const { job_id, type } = e.detail;
      if (type === 'job_completed' || type === 'job_failed') {
        // Coerce both sides: SSE may deliver job_id as string or number
        setJobs(prev => prev.filter(j => Number(j.id) !== Number(job_id)));
      }
    };

    window.addEventListener('scanJobUpdate', handleJobUpdate);
    return () => window.removeEventListener('scanJobUpdate', handleJobUpdate);
  }, []);

  const pendingCount = jobs.filter(j => j.status === 'PENDING' || j.status === 'PROCESSING').length;

  return {
    jobs,
    addJob,
    removeJob,
    pendingCount,
  };
}
