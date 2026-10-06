import React from 'react';
import { Link } from 'react-router-dom';
import Lottie from 'lottie-react';
import { workerAnimation, customerAnimation } from '../assets/animations';

const Home = () => {
  const workerAnim = workerAnimation;
  const customerAnim = customerAnimation;

  return (
    <div className="min-h-[calc(100vh-72px)] flex flex-col items-center justify-center p-6 animate-fade-in-up">
      {/* Hero */}
      <div className="text-center mb-12 max-w-2xl">
        <div className="inline-flex items-center gap-2 bg-sky-50 text-sky-700 text-sm font-medium px-4 py-2 rounded-full mb-6">
          <span className="w-2 h-2 bg-sky-500 rounded-full animate-pulse"></span>
          Trusted Local Marketplace
        </div>
        <h1 className="text-5xl font-extrabold text-slate-900 leading-tight">
          Connect with Skilled
          <span className="text-sky-600"> Professionals</span>
        </h1>
        <p className="mt-4 text-lg text-slate-500 leading-relaxed">
          Find verified plumbers, painters, electricians and more —
          or offer your skills and grow your business.
        </p>
      </div>

      {/* Gateway Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8 w-full max-w-3xl">
        {/* Customer Card */}
        <Link
          to="/register"
          className="card card-hover group p-8 flex flex-col items-center text-center cursor-pointer border-2 border-transparent hover:border-sky-200"
        >
          <div className="w-40 h-40 mb-4">
            {customerAnim ? (
              <Lottie animationData={customerAnim} loop autoplay />
            ) : (
              <div className="w-full h-full bg-sky-50 rounded-2xl flex items-center justify-center">
                <span className="text-6xl">🏠</span>
              </div>
            )}
          </div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-sky-600 transition-colors">
            I need a Service
          </h2>
          <p className="text-slate-500 mt-2 text-sm leading-relaxed">
            Find top-rated professionals near you, compare reviews, and book instantly.
          </p>
          <div className="mt-6 btn-primary w-full text-center">
            Get Started →
          </div>
        </Link>

        {/* Provider Card */}
        <Link
          to="/register/pro"
          className="card card-hover group p-8 flex flex-col items-center text-center cursor-pointer border-2 border-transparent hover:border-emerald-200"
        >
          <div className="w-40 h-40 mb-4">
            {workerAnim ? (
              <Lottie animationData={workerAnim} loop autoplay />
            ) : (
              <div className="w-full h-full bg-emerald-50 rounded-2xl flex items-center justify-center">
                <span className="text-6xl">🔧</span>
              </div>
            )}
          </div>
          <h2 className="text-2xl font-bold text-slate-800 group-hover:text-emerald-600 transition-colors">
            I want to Work
          </h2>
          <p className="text-slate-500 mt-2 text-sm leading-relaxed">
            Join our network, accept jobs in your area, and grow your client base.
          </p>
          <div className="mt-6 bg-emerald-600 text-white font-semibold py-3 px-6 rounded-xl w-full text-center hover:bg-emerald-700 transition-all shadow-sm">
            Start Earning →
          </div>
        </Link>
      </div>

      {/* Trust indicators */}
      <div className="flex items-center gap-8 mt-16 text-slate-400 text-sm">
        <span className="flex items-center gap-2">✅ Verified Professionals</span>
        <span className="flex items-center gap-2">⭐ Rated by Real Customers</span>
        <span className="flex items-center gap-2">📍 Location-Aware Search</span>
      </div>
    </div>
  );
};

export default Home;
