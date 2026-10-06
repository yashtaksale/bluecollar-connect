import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import Lottie from 'lottie-react';
import { useLottieUrl } from '../hooks/useLottieUrl';
import api, { getUsername } from '../api/client';

const LOTTIE_URLS = {
  PLUMBER: 'https://lottie.host/b30ec0eb-790c-4a49-b704-0e2346e3406d/Vs5cBJCZhW.json',
  PAINTER: 'https://lottie.host/f72c6cba-8e29-4a2e-9a2c-e6b5e09c9fa8/dY8jMGcxvX.json',
  ELECTRICIAN: 'https://lottie.host/1b0e9d2d-60a5-42c9-858d-7ed622a39b08/RBkPm3PVPC.json',
  CLEANING: 'https://lottie.host/e7b05afc-2178-4a91-afc4-c81b4e3eb7a5/3fXcxqLfVn.json',
  APPLIANCE_REPAIR: 'https://lottie.host/a40ead24-78d8-4e63-8af8-d8e90e8f6e4a/Qz8h38bVEi.json',
  PEST_CONTROL: 'https://lottie.host/55e3cf0d-ca55-49e6-b83e-92a6dfab17a5/B5eLeJp7qv.json',
};

const services = [
  { key: 'PLUMBER', label: 'Plumber', emoji: '🔧', color: 'sky', desc: 'Pipe leaks, installations, bathroom repairs', keywords: 'pipe leak tap water bathroom drain' },
  { key: 'PAINTER', label: 'Painter', emoji: '🎨', color: 'violet', desc: 'Interior design, wall painting, touch-ups', keywords: 'paint wall colour interior' },
  { key: 'ELECTRICIAN', label: 'Electrician', emoji: '⚡', color: 'amber', desc: 'Wiring, fixtures, electrical safety checks', keywords: 'wiring light switch fan power socket' },
  { key: 'CLEANING', label: 'Cleaning', emoji: '🧹', color: 'emerald', desc: 'Deep cleaning, move-out, regular maintenance', keywords: 'clean deep sofa kitchen maid' },
  { key: 'APPLIANCE_REPAIR', label: 'Appliance Repair', emoji: '🔩', color: 'rose', desc: 'AC, fridge, washing machine, microwave', keywords: 'ac fridge washing machine microwave repair' },
  { key: 'PEST_CONTROL', label: 'Pest Control', emoji: '🐛', color: 'teal', desc: 'Termite, rodent, cockroach treatment', keywords: 'pest termite rat cockroach mosquito' },
];

const STATUS_PILL = {
  PENDING:   { label: 'Waiting for a pro', cls: 'bg-amber-50 text-amber-700' },
  ACCEPTED:  { label: 'Needs your confirmation', cls: 'bg-sky-50 text-sky-700' },
  CONFIRMED: { label: 'Scheduled', cls: 'bg-emerald-50 text-emerald-700' },
};

const ServiceCard = ({ service, onNavigate }) => {
  const lottieData = useLottieUrl(LOTTIE_URLS[service.key]);

  return (
    <div className="card card-hover group p-6 flex flex-col items-center text-center cursor-pointer"
         onClick={() => onNavigate(service.key)}>
      {/* Lottie animation or emoji fallback */}
      <div className="w-24 h-24 mb-4 flex items-center justify-center">
        {lottieData ? (
          <Lottie animationData={lottieData} loop autoplay className="w-full h-full" />
        ) : (
          <div className="animate-float">
            <span className="text-5xl">{service.emoji}</span>
          </div>
        )}
      </div>

      <h3 className="text-lg font-bold text-slate-800 group-hover:text-sky-600 transition-colors">
        {service.label}
      </h3>
      <p className="text-slate-400 mt-1 text-sm leading-relaxed">{service.desc}</p>

      <button className="mt-4 w-full btn-primary text-sm !py-2.5">
        Find & Book →
      </button>
    </div>
  );
};

const CustomerDashboard = () => {
  const navigate = useNavigate();
  const username = getUsername() || 'there';
  const [query, setQuery] = useState('');
  const [activeJobs, setActiveJobs] = useState([]);

  // A booked job used to be reachable only from the URL you happened to be on.
  // Surface anything still in flight right where the customer lands.
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const { data } = await api.get('/jobs/mine/', {
          params: { status: 'PENDING,ACCEPTED,CONFIRMED' },
          signal: controller.signal,
        });
        setActiveJobs(Array.isArray(data) ? data : data.results || []);
      } catch {
        /* non-critical strip — the service grid below still works */
      }
    })();
    return () => controller.abort();
  }, []);

  // The search box used to have an onChange that computed a value and threw it
  // away; only Enter did anything. Now it filters as you type.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return services;
    return services.filter(s =>
      s.label.toLowerCase().includes(q) ||
      s.desc.toLowerCase().includes(q) ||
      s.keywords.includes(q)
    );
  }, [query]);

  const handleEnter = (e) => {
    if (e.key !== 'Enter') return;
    if (filtered.length > 0) navigate(`/find/${filtered[0].key}`);
  };

  return (
    <div className="max-w-6xl mx-auto py-8 px-6 animate-fade-in-up">
      {/* Welcome & Search */}
      <div className="mb-10 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h1 className="text-3xl font-extrabold text-slate-900">
            Hey {username} 👋
          </h1>
          <p className="text-slate-500 mt-1">
            What service do you need today? We'll find the best-rated pros near you.
          </p>
        </div>

        {/* Search Bar */}
        <div className="relative w-full md:w-96">
          <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          <input
            type="text"
            value={query}
            placeholder="Search for 'Plumber', 'leaking tap'..."
            className="w-full pl-11 pr-4 py-3.5 bg-white border-2 border-slate-100 rounded-2xl shadow-sm focus:border-sky-500 focus:ring-4 focus:ring-sky-50 outline-none transition-all font-medium text-slate-700"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleEnter}
          />
          <div className="absolute inset-y-0 right-0 pr-4 flex items-center pointer-events-none">
            <span className="text-xs font-bold text-slate-300 bg-slate-50 px-2 py-1 rounded-lg border border-slate-100">ENTER</span>
          </div>
        </div>
      </div>

      {/* Jobs in flight */}
      {activeJobs.length > 0 && (
        <div className="mb-10">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-bold text-slate-800">Your active jobs</h2>
            <Link to="/jobs" className="text-sm font-semibold text-sky-600 hover:text-sky-700">
              View all →
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeJobs.slice(0, 3).map(job => {
              const pill = STATUS_PILL[job.status] || { label: job.status_display || job.status, cls: 'bg-slate-100 text-slate-600' };
              return (
                <Link
                  key={job.id}
                  to={`/job/${job.id}`}
                  className="card p-4 hover:shadow-md transition-shadow block"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-bold text-slate-800 text-sm truncate">
                      {job.service_type_display || `Job #${job.id}`}
                    </p>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-md whitespace-nowrap ${pill.cls}`}>
                      {pill.label}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 mt-1.5 truncate">
                    {job.provider_username ? `with ${job.provider_username}` : 'Looking for a pro nearby'}
                  </p>
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* Service Grid */}
      {filtered.length === 0 ? (
        <div className="bg-slate-50 rounded-2xl p-10 text-center border-2 border-dashed border-slate-200">
          <div className="text-4xl mb-3">🔍</div>
          <p className="text-slate-500 font-medium">No service matches "{query}".</p>
          <button onClick={() => setQuery('')} className="mt-3 text-sm font-semibold text-sky-600 hover:text-sky-700">
            Clear search
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filtered.map((service) => (
            <ServiceCard
              key={service.key}
              service={service}
              onNavigate={(key) => navigate(`/find/${key}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default CustomerDashboard;
