#!/usr/bin/env python3
"""
Test suite for PQC workflow and signature verification script.
"""

import py_compile
import unittest
from pathlib import Path


class TestPQCWorkflow(unittest.TestCase):
    def setUp(self):
        self.root_dir = Path(__file__).parent.parent
        self.verify_script = self.root_dir / "scripts" / "verify_pqc_signatures.py"

    def test_verification_script_exists_and_valid(self):
        """
        Verify that the verification script exists, is readable, and compiles without syntax errors.
        Dropped brittle os.access(..., os.X_OK) check for cross-platform compatibility.
        """
        self.assertTrue(self.verify_script.exists(), "Verification script must exist")
        self.assertTrue(self.verify_script.is_file(), "Verification script must be a file")
        
        # Test python syntax compilation readiness instead of executable permissions bit
        compiled = False
        try:
            py_compile.compile(str(self.verify_script), doraise=True)
            compiled = True
        except py_compile.PyCompileError as exc:
            compiled = False
            print(f"Syntax compilation error in script: {exc}")
            
        self.assertTrue(compiled, "Verification script must be valid Python syntax")

    def test_workflow_file_exists(self):
        workflow_path = self.root_dir / ".github" / "workflows" / "pqc-artifact-signing.yml"
        self.assertTrue(workflow_path.exists(), "PQC workflow YAML must exist")


if __name__ == "__main__":
    unittest.main()
