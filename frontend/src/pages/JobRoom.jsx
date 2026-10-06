import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api, { getUserRole } from '../api/client';
import toast from 'react-hot-toast';
import Lottie from 'lottie-react';
import { waitingAnimation } from '../assets/animations';

/* ─── Reusable Components ─── */
const StarRatingInput = ({ rating, setRating, disabled = false }) => {
    const [hover, setHover] = useState(0);
    return (
        <div className="flex gap-1 justify-center">
            {[1, 2, 3, 4, 5].map((star) => (
                <button
                    key={star}
                    type="button"
                    disabled={disabled}
                    onClick={() => setRating(star)}
                    onMouseEnter={() => !disabled && setHover(star)}
                    onMouseLeave={() => !disabled && setHover(0)}
                    aria-label={`${star} star${star > 1 ? 's' : ''}`}
                    className={`text-3xl transition-transform ${
                        disabled ? 'cursor-default' : 'cursor-pointer hover:scale-110'
                    } ${
                        star <= (hover || rating) ? 'text-yellow-400' : 'text-gray-300'
                    }`}
                >
                    ★
                </button>
            ))}
        </div>
    );
};

/** The customer's message to the provider. It was stored and never displayed. */
const CustomerNote = ({ note, viewerIsProvider }) => {
    if (!note) return null;
    return (
        <div className="bg-amber-50 border border-amber-200 p-5 rounded-2xl text-left">
            <p className="text-xs font-black text-amber-700 uppercase tracking-wider mb-2">
                {viewerIsProvider ? "Customer's note for you" : 'Your note to the pro'}
            </p>
            <p className="text-amber-900 font-medium leading-relaxed whitespace-pre-wrap">{note}</p>
        </div>
    );
};

/** `datetime-local` needs a local-time string, not an ISO/UTC one. */
const localInputValue = (date) => {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
        + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const errorFrom = (err, fallback) =>
    err?.response?.data?.error || err?.response?.data?.detail || fallback;

/* ─── Main Job Room ─── */
const JobRoom = () => {
    const { jobId } = useParams();
    const navigate = useNavigate();
    const [job, setJob] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [submitting, setSubmitting] = useState(false);
    const [scheduledFor, setScheduledFor] = useState('');
    const [notes, setNotes] = useState('');
    const [showCancel, setShowCancel] = useState(false);
    const [cancelReason, setCancelReason] = useState('');
    const [rating, setRating] = useState(0);
    const [reviewComment, setReviewComment] = useState('');

    // The server tells us which side of the job the caller is on. localStorage
    // is only the pre-load fallback: it's client-editable and can disagree with
    // the account that actually owns the job.
    const viewerRole = job?.viewer_role || getUserRole();
    const isCustomer = viewerRole === 'CUSTOMER';
    const isProvider = viewerRole === 'SERVICE_PROVIDER';
    const dashboardPath = isProvider ? '/provider' : '/customer';

    // Local waiting animation
    const animationData = waitingAnimation;

    // ─── Poll sequencing ───
    // Every fetch takes a ticket. Only the holder of the newest ticket is allowed
    // to write to state, so a slow poll issued *before* a transition can never
    // land *after* it and revert the UI to the old status.
    const latestReqRef = useRef(0);
    const abortRef = useRef(null);
    const mountedRef = useRef(true);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            abortRef.current?.abort();
        };
    }, []);

    const isCanceled = (err) =>
        err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError' || err?.name === 'AbortError';

    const fetchJobDetails = useCallback(async () => {
        // Whatever is still in flight is already obsolete — stop paying for it.
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        const seq = ++latestReqRef.current;
        const isStale = () => seq !== latestReqRef.current || !mountedRef.current;

        try {
            const res = await api.get(`/jobs/${jobId}/`, { signal: controller.signal });
            if (isStale()) return;
            setJob(res.data);
            setError(null);
        } catch (err) {
            if (isCanceled(err) || isStale()) return;
            // 401s are handled by the api client (refresh-then-retry, or
            // redirect to /login if the refresh itself fails), so don't paint
            // an error screen over a request that's about to be retried.
            if (err.response?.status !== 401) {
                const code = err.response?.status;
                setError(
                    code === 403 ? "You don't have access to this job."
                    : code === 404 ? "That job doesn't exist."
                    : errorFrom(err, "Couldn't load this job. Check your connection.")
                );
            }
        } finally {
            // Previously inside try/, so any failure left the spinner up forever.
            if (!isStale()) setLoading(false);
        }
    }, [jobId]);

    const handleRetry = () => {
        setLoading(true);
        setError(null);
        fetchJobDetails();
    };

    useEffect(() => {
        fetchJobDetails();
        const interval = setInterval(fetchJobDetails, 5000);
        return () => clearInterval(interval);
    }, [fetchJobDetails]);

    const handleConfirmBooking = async () => {
        if (!scheduledFor) return toast.error('Please pick a date and time!');
        setSubmitting(true);
        try {
            await api.patch(`/jobs/${jobId}/confirm/`, {
                scheduled_for: scheduledFor,
                notes: notes,
            });
            toast.success('Booking Finalized! ✅');
            await fetchJobDetails();
        } catch (err) {
            // The server rejects past times, wrong states and over-long notes
            // with a specific message — showing a generic one hid all of them.
            toast.error(errorFrom(err, 'Failed to confirm booking.'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleMarkComplete = async () => {
        // Without a guard, double-clicking fired two PATCHes; the second one
        // 409s and popped a scary error on top of a job that did complete.
        if (submitting) return;
        setSubmitting(true);
        try {
            await api.patch(`/jobs/${jobId}/complete/`, {});
            toast.success('Job marked as completed! 🎊');
            await fetchJobDetails();
        } catch (err) {
            toast.error(errorFrom(err, 'Failed to complete job.'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleCancel = async () => {
        if (submitting) return;
        setSubmitting(true);
        try {
            await api.patch(`/jobs/${jobId}/cancel/`, { reason: cancelReason.trim() });
            toast.success('Job cancelled.');
            setShowCancel(false);
            setCancelReason('');
            await fetchJobDetails();
        } catch (err) {
            toast.error(errorFrom(err, 'Could not cancel this job.'));
        } finally {
            setSubmitting(false);
        }
    };

    const handleSubmitReview = async () => {
        if (submitting) return;
        if (rating < 1) return toast.error('Pick a star rating first.');
        setSubmitting(true);
        try {
            await api.post('/reviews/', {
                job_id: Number(jobId),
                rating,
                comment: reviewComment.trim(),
            });
            toast.success('Thanks for the review! ⭐');
            setReviewComment('');
            await fetchJobDetails();
        } catch (err) {
            toast.error(errorFrom(err, 'Could not submit your review.'));
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-indigo-600 border-t-transparent"></div>
        </div>
    );

    // Only take over the screen when we have nothing to show. If a poll fails
    // while we already have job data, we keep rendering it (banner below).
    if (!job) return (
        <div className="min-h-screen flex items-center justify-center bg-slate-50 px-6">
            <div className="max-w-sm w-full bg-white rounded-3xl shadow-xl shadow-slate-200/50 border border-slate-100 p-8 text-center space-y-5">
                <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto text-3xl">⚠️</div>
                <div>
                    <h2 className="text-xl font-black text-slate-800">Couldn't load Job #{jobId}</h2>
                    <p className="text-slate-500 mt-2 font-medium text-sm">
                        {error || 'Something went wrong loading this job.'}
                    </p>
                </div>
                <div className="space-y-2">
                    <button
                        onClick={handleRetry}
                        className="w-full bg-indigo-600 text-white font-black py-3.5 rounded-2xl hover:bg-indigo-700 transition-all active:scale-95"
                    >
                        Try Again
                    </button>
                    <button
                        onClick={() => navigate(dashboardPath)}
                        className="w-full bg-slate-100 text-slate-600 font-bold py-3 rounded-2xl hover:bg-slate-200 transition-all"
                    >
                        Back to Dashboard
                    </button>
                </div>
            </div>
        </div>
    );

    const status = job.status;
    const canCancel = ['PENDING', 'ACCEPTED', 'CONFIRMED'].includes(status);
    const counterpartName = isProvider ? job.customer?.username : job.provider?.username;

    return (
        <div className="min-h-screen bg-slate-50 py-12 px-6">
            <div className="max-w-xl mx-auto bg-white rounded-3xl shadow-xl shadow-slate-200/50 overflow-hidden border border-slate-100">
                {/* Header */}
                <div className={`p-8 text-white ${
                    status === 'CANCELLED'
                        ? 'bg-gradient-to-br from-slate-700 to-slate-500'
                        : 'bg-gradient-to-br from-indigo-700 to-indigo-500'
                }`}>
                    <div className="flex justify-between items-start mb-6">
                        <div>
                            <span className="text-xs font-black uppercase tracking-widest text-indigo-200">
                                {job.service_type_display || 'Job Detail Hub'}
                            </span>
                            <h1 className="text-3xl font-black mt-1">Ref #{jobId}</h1>
                        </div>
                        <div className={`px-4 py-1.5 rounded-full text-xs font-black uppercase tracking-widest ${
                            status === 'PENDING' ? 'bg-amber-400 text-amber-950' :
                            status === 'ACCEPTED' ? 'bg-sky-400 text-sky-950' :
                            status === 'CONFIRMED' ? 'bg-emerald-400 text-emerald-950' :
                            status === 'CANCELLED' ? 'bg-rose-300 text-rose-950' :
                            'bg-slate-700 text-slate-200'
                        }`}>
                            {(job.status_display || status).replace('_', ' ')}
                        </div>
                    </div>

                    {/* Who you're dealing with. The provider previously had no
                        idea whose job this was. */}
                    {counterpartName && (
                        <div className="flex items-center gap-4 bg-white/10 p-4 rounded-2xl backdrop-blur-sm border border-white/10">
                            <div className="w-12 h-12 rounded-full bg-white/20 flex items-center justify-center text-xl font-black">
                                {counterpartName.charAt(0).toUpperCase()}
                            </div>
                            <div>
                                <h3 className="font-bold text-lg">{counterpartName}</h3>
                                <p className="text-indigo-100 text-xs font-medium uppercase tracking-wider">
                                    {isProvider
                                        ? 'Customer'
                                        : `${job.provider?.category}${job.agreed_price ? ` • ₹${job.agreed_price}/hr` : ''}`}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-8">
                    {/* A poll failed but we still have the last known good state. */}
                    {error && (
                        <div className="mb-6 flex items-center justify-between gap-3 bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3">
                            <p className="text-xs font-bold text-amber-800">
                                Live updates interrupted — showing the last known status.
                            </p>
                            <button
                                onClick={handleRetry}
                                className="text-xs font-black text-amber-900 underline whitespace-nowrap hover:text-amber-950"
                            >
                                Retry
                            </button>
                        </div>
                    )}

                    {/* ──── STEP 1: PENDING ──── */}
                    {status === 'PENDING' && (
                        <div className="text-center space-y-6 py-4">
                            <div className="w-48 h-48 mx-auto">
                                {animationData && <Lottie animationData={animationData} loop autoplay />}
                            </div>
                            <div>
                                <h2 className="text-2xl font-black text-slate-800">
                                    {isProvider ? 'New request' : 'Waiting for Pro...'}
                                </h2>
                                <p className="text-slate-500 mt-2 font-medium">
                                    {isProvider
                                        ? `${job.customer?.username} is waiting on your response. Accept it from your dashboard.`
                                        : `We've notified ${job.provider?.username || 'nearby pros'}. They'll review your request and accept if they're available.`}
                                </p>
                            </div>
                            <div className="bg-slate-50 p-4 rounded-2xl border border-slate-100 text-left">
                                <p className="text-xs font-black text-slate-400 uppercase mb-2">Service Description</p>
                                <p className="text-slate-700 font-medium italic">"{job.description}"</p>
                            </div>
                        </div>
                    )}

                    {/* ──── STEP 2: ACCEPTED ──── */}
                    {status === 'ACCEPTED' && (
                        <div className="space-y-8 py-4">
                            <div className="text-center">
                                <div className="w-16 h-16 bg-sky-100 text-sky-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">🙌</div>
                                <h2 className="text-2xl font-black text-slate-800">Provider is Interested!</h2>
                                <p className="text-slate-500 mt-2 font-medium">
                                    {isCustomer ? 'Choose a time to confirm your booking.' : 'Waiting on the customer to pick a time.'}
                                </p>
                            </div>

                            {isCustomer ? (
                                <div className="space-y-6">
                                    <div className="space-y-2">
                                        <label className="block text-sm font-bold text-slate-700">Select Date & Time</label>
                                        <input
                                            type="datetime-local"
                                            value={scheduledFor}
                                            min={localInputValue(new Date())}
                                            onChange={(e) => setScheduledFor(e.target.value)}
                                            className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all font-bold text-slate-700"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="block text-sm font-bold text-slate-700">Add a Message (Optional)</label>
                                        <textarea
                                            placeholder="Explain the problem briefly..."
                                            value={notes}
                                            onChange={(e) => setNotes(e.target.value)}
                                            rows={3}
                                            maxLength={1000}
                                            className="w-full px-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all font-medium text-slate-700 resize-none"
                                        />
                                    </div>
                                    <button
                                        onClick={handleConfirmBooking}
                                        disabled={submitting}
                                        className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-xl shadow-indigo-100 hover:bg-indigo-700 hover:-translate-y-1 transition-all active:scale-95 disabled:opacity-60 disabled:hover:translate-y-0 flex items-center justify-center gap-2"
                                    >
                                        {submitting ? 'Processing...' : 'Confirm & Schedule Booking'}
                                    </button>
                                </div>
                            ) : (
                                <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100 text-center">
                                    <p className="text-slate-600 font-bold">Waiting for customer to pick a time...</p>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ──── STEP 3: CONFIRMED ──── */}
                    {status === 'CONFIRMED' && (
                        <div className="space-y-8 py-4">
                            <div className="text-center">
                                <div className="w-16 h-16 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-4 text-3xl">📅</div>
                                <h2 className="text-2xl font-black text-slate-800">Job Finalized!</h2>
                                <p className="text-slate-500 mt-2 font-medium">
                                    {isProvider ? "You're scheduled to arrive at:" : 'The pro is scheduled to arrive at:'}
                                </p>
                                <div className="mt-4 bg-emerald-50 text-emerald-700 py-3 px-6 rounded-2xl font-black text-lg border border-emerald-100 inline-block">
                                    {job.scheduled_for
                                        ? new Date(job.scheduled_for).toLocaleString([], { dateStyle: 'long', timeStyle: 'short' })
                                        : 'Time to be confirmed'}
                                </div>
                            </div>

                            {/* Item 5: the customer's note finally reaches the pro. */}
                            <CustomerNote note={job.provider_notes} viewerIsProvider={isProvider} />

                            {isProvider && (
                                <button
                                    onClick={handleMarkComplete}
                                    disabled={submitting}
                                    className="w-full bg-emerald-600 text-white font-black py-5 rounded-2xl shadow-xl shadow-emerald-100 hover:bg-emerald-700 hover:-translate-y-1 transition-all active:scale-95 disabled:opacity-60 disabled:hover:translate-y-0 flex items-center justify-center gap-2"
                                >
                                    {submitting ? 'Saving...' : '✅ Mark Work as Complete'}
                                </button>
                            )}
                            <div className="pt-6 border-t border-slate-100">
                                <p className="text-xs font-black text-slate-400 uppercase mb-4 text-center">Need help? Support ID: #{jobId}</p>
                            </div>
                        </div>
                    )}

                    {/* ──── STEP 4: COMPLETED ──── */}
                    {status === 'COMPLETED' && (
                        <div className="text-center space-y-6">
                            <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mx-auto text-3xl font-black">✨</div>
                            <h2 className="text-2xl font-black text-slate-800">Job Done!</h2>

                            <CustomerNote note={job.provider_notes} viewerIsProvider={isProvider} />

                            {/* Review form. The star input existed but was never
                                rendered, so /api/reviews/ had no caller at all. */}
                            {job.can_review && (
                                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-6 space-y-4 text-left">
                                    <div className="text-center">
                                        <p className="text-sm font-black text-slate-700">
                                            How did {job.provider?.username || 'your pro'} do?
                                        </p>
                                        <p className="text-xs text-slate-500 mt-1">Your rating decides who gets ranked first.</p>
                                    </div>
                                    <StarRatingInput rating={rating} setRating={setRating} disabled={submitting} />
                                    <textarea
                                        placeholder="Anything you'd tell the next customer? (optional)"
                                        value={reviewComment}
                                        onChange={(e) => setReviewComment(e.target.value)}
                                        rows={3}
                                        maxLength={1000}
                                        className="w-full px-4 py-3 bg-white border-2 border-slate-100 rounded-2xl focus:border-indigo-500 focus:ring-4 focus:ring-indigo-50 outline-none transition-all font-medium text-slate-700 resize-none"
                                    />
                                    <button
                                        onClick={handleSubmitReview}
                                        disabled={submitting || rating < 1}
                                        className="w-full bg-indigo-600 text-white font-black py-4 rounded-2xl hover:bg-indigo-700 transition-all active:scale-95 disabled:opacity-50"
                                    >
                                        {submitting ? 'Submitting...' : 'Submit Review'}
                                    </button>
                                </div>
                            )}

                            {job.has_review && (
                                <p className="text-sm font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-2xl py-3 px-4">
                                    ⭐ Review submitted — thanks!
                                </p>
                            )}

                            <button
                                onClick={() => navigate(dashboardPath)}
                                className="w-full bg-slate-900 text-white font-black py-4 rounded-xl hover:bg-slate-800 transition-all"
                            >
                                Back to Dashboard
                            </button>
                        </div>
                    )}

                    {/* ──── CANCELLED ──── */}
                    {/* This status existed in the model from day one but nothing
                        rendered it: a cancelled job fell through every branch
                        and showed an empty card. */}
                    {status === 'CANCELLED' && (
                        <div className="text-center space-y-5">
                            <div className="w-16 h-16 bg-rose-100 text-rose-600 rounded-full flex items-center justify-center mx-auto text-3xl">🚫</div>
                            <h2 className="text-2xl font-black text-slate-800">Job Cancelled</h2>
                            <p className="text-slate-500 font-medium">
                                {job.cancelled_by
                                    ? `Cancelled by ${job.cancelled_by}.`
                                    : 'This job is no longer active.'}
                            </p>
                            {job.cancellation_reason && (
                                <div className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-left">
                                    <p className="text-xs font-black text-slate-400 uppercase mb-2">Reason</p>
                                    <p className="text-slate-700 font-medium italic">"{job.cancellation_reason}"</p>
                                </div>
                            )}
                            <button
                                onClick={() => navigate(dashboardPath)}
                                className="w-full bg-slate-900 text-white font-black py-4 rounded-xl hover:bg-slate-800 transition-all"
                            >
                                Back to Dashboard
                            </button>
                        </div>
                    )}

                    {/* ──── Cancel control ──── */}
                    {canCancel && (
                        <div className="mt-8 pt-6 border-t border-slate-100">
                            {!showCancel ? (
                                <button
                                    onClick={() => setShowCancel(true)}
                                    className="w-full text-sm font-bold text-rose-600 py-3 rounded-xl hover:bg-rose-50 transition-all"
                                >
                                    Cancel this job
                                </button>
                            ) : (
                                <div className="space-y-3 bg-rose-50 border border-rose-100 rounded-2xl p-5">
                                    <p className="text-sm font-black text-rose-900">
                                        Cancel job #{jobId}?
                                    </p>
                                    <p className="text-xs text-rose-700">
                                        {counterpartName ? `${counterpartName} will be notified.` : 'This cannot be undone.'}
                                    </p>
                                    <textarea
                                        placeholder="Reason (optional)"
                                        value={cancelReason}
                                        onChange={(e) => setCancelReason(e.target.value)}
                                        rows={2}
                                        maxLength={1000}
                                        className="w-full px-4 py-3 bg-white border-2 border-rose-100 rounded-xl outline-none focus:border-rose-300 text-sm font-medium text-slate-700 resize-none"
                                    />
                                    <div className="flex gap-2">
                                        <button
                                            onClick={() => { setShowCancel(false); setCancelReason(''); }}
                                            disabled={submitting}
                                            className="flex-1 bg-white text-slate-600 font-bold py-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-all disabled:opacity-50"
                                        >
                                            Keep it
                                        </button>
                                        <button
                                            onClick={handleCancel}
                                            disabled={submitting}
                                            className="flex-1 bg-rose-600 text-white font-black py-3 rounded-xl hover:bg-rose-700 transition-all disabled:opacity-50"
                                        >
                                            {submitting ? 'Cancelling...' : 'Cancel job'}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default JobRoom;
